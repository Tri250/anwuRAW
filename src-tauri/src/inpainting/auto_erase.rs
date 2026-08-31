use image::{GrayImage, Luma};

/// 端侧"自动消除"分割：从种子点做边缘/颜色感知的区域生长。
///
/// 不需要任何检测模型，完全本地即可把用户点击的连通对象切出来（近似"魔棒/快速选择"）：
/// - 以 4 邻接进行泛洪；是否并入取决于与区域均值的颜色距离 + 是否跨过强边缘。
/// - 自适应容差：依据种子点局部对比度设定，目标：贴齐物体而不漏选、不溢色到背景。
/// 输出与输入等大的二值蒙版（背景 0、对象 255）。
///
/// `sensitivity`：用户可调的灵敏度（0..100），映射为容差因子 [0.6, 1.6]。
/// 灵敏度越高，颜色容差越大、越容易越过弱边缘，语义为"选得更狠、擦得更干净"；
/// 越低则越严格贴齐对象边缘。
pub fn region_grow_mask(
    source: &image::DynamicImage,
    seed: (u32, u32),
    w: u32,
    h: u32,
    sensitivity: f32,
) -> GrayImage {
    let rgb = source.to_rgb8();

    // 亮度 + Sobel 梯度幅值（用于阻止区域生长越过强边缘）
    let mut lum = vec![0.0f32; (w * h) as usize];
    for y in 0..h {
        for x in 0..w {
            let p = rgb.get_pixel(x, y);
            lum[(y * w + x) as usize] = 0.299 * p[0] as f32 + 0.587 * p[1] as f32 + 0.114 * p[2] as f32;
        }
    }
    let grad = sobel_magnitude(&lum, w, h);

    let (sx, sy) = seed;
    let seed_idx = (sy * w + sx) as usize;
    let seed_col = rgb.get_pixel(sx, sy);

    // 灵敏度因子：0..100 → [0.6, 1.6]
    let sens = sensitivity.clamp(0.0, 100.0);
    let factor = 0.6 + (sens / 100.0) * 1.0;

    // 自适应容差：采样种子局部 5x5 邻域的亮度标准差（对比度）
    let base_contrast = local_std(&lum, w, h, sx, sy, 2);
    let tol_color = (18.0 + 0.6 * base_contrast).clamp(13.0, 52.0) * factor;
    // 灵敏度越高，越允许越过弱边缘（梯度阈值线性降低）
    let grad_thresh = ((16.0 + 1.6 * base_contrast).clamp(20.0, 90.0)) / factor;

    let mut mask = vec![0u8; (w * h) as usize];
    let mut sum_r = seed_col[0] as f32;
    let mut sum_g = seed_col[1] as f32;
    let mut sum_b = seed_col[2] as f32;
    let mut count = 1u32;

    let mut visited = vec![false; (w * h) as usize];
    visited[seed_idx] = true;
    mask[seed_idx] = 255;

    let mut stack: Vec<(u32, u32)> = vec![(sx, sy)];
    while let Some((cx, cy)) = stack.pop() {
        for (nx, ny) in neighbors(cx, cy, w, h) {
            let idx = (ny * w + nx) as usize;
            if visited[idx] {
                continue;
            }
            visited[idx] = true;

            // 跳过强梯度（对象与背景的边界）
            if grad[idx] > grad_thresh {
                continue;
            }

            let p = rgb.get_pixel(nx, ny);
            // 与区域当前均值的欧氏颜色距离
            let dr = (p[0] as f32 - sum_r / count as f32).max((p[0] as f32 - sum_r / count as f32) * -1.0);
            let dg = (p[1] as f32 - sum_g / count as f32).max((p[1] as f32 - sum_g / count as f32) * -1.0);
            let db = (p[2] as f32 - sum_b / count as f32).max((p[2] as f32 - sum_b / count as f32) * -1.0);
            let dist = (dr * dr + dg * dg + db * db).sqrt();

            if dist <= tol_color {
                mask[idx] = 255;
                count += 1;
                sum_r += p[0] as f32;
                sum_g += p[1] as f32;
                sum_b += p[2] as f32;
                stack.push((nx, ny));
            }
        }

        // 防御：单次生长上限，避免整图连通溢色导致大修
        if count > (w * h) / 3 {
            break;
        }
    }

    gray_from_bytes(&mask, w, h)
}

/// 4 邻接枚举（边界安全，仅返回有效的邻居坐标）
#[inline]
fn neighbors(x: u32, y: u32, w: u32, h: u32) -> Vec<(u32, u32)> {
    let mut out = Vec::with_capacity(4);
    if x > 0 {
        out.push((x - 1, y));
    }
    if x + 1 < w {
        out.push((x + 1, y));
    }
    if y > 0 {
        out.push((x, y - 1));
    }
    if y + 1 < h {
        out.push((x, y + 1));
    }
    out
}

fn sobel_magnitude(lum: &[f32], w: u32, h: u32) -> Vec<f32> {
    let wu = w as usize;
    let hu = h as usize;
    let mut g = vec![0.0f32; lum.len()];
    for y in 1..hu - 1 {
        for x in 1..wu - 1 {
            let i = y * wu + x;
            let gx = -lum[i - wu - 1] - 2.0 * lum[i - wu] - lum[i - wu + 1]
                + lum[i + wu - 1]
                + 2.0 * lum[i + wu]
                + lum[i + wu + 1];
            let gy = -lum[i - wu - 1] - 2.0 * lum[i - 1] - lum[i + wu - 1]
                + lum[i - wu + 1]
                + 2.0 * lum[i + 1]
                + lum[i + wu + 1];
            g[i] = (gx * gx + gy * gy).sqrt();
        }
    }
    g
}

/// 局部亮度标准差（半径 radius 的方形窗口内）
fn local_std(lum: &[f32], w: u32, h: u32, cx: u32, cy: u32, radius: u32) -> f32 {
    let x0 = cx.saturating_sub(radius);
    let x1 = (cx + radius).min(w - 1);
    let y0 = cy.saturating_sub(radius);
    let y1 = (cy + radius).min(h - 1);
    let mut sum = 0.0f32;
    let mut n = 0f32;
    for y in y0..=y1 {
        for x in x0..=x1 {
            sum += lum[(y * w + x) as usize];
            n += 1.0;
        }
    }
    let mean = sum / n;
    let mut var = 0.0f32;
    for y in y0..=y1 {
        for x in x0..=x1 {
            let d = lum[(y * w + x) as usize] - mean;
            var += d * d;
        }
    }
    (var / n).sqrt()
}

fn gray_from_bytes(data: &[u8], w: u32, h: u32) -> GrayImage {
    let mut img = GrayImage::from_pixel(w, h, Luma([0]));
    for (i, &v) in data.iter().enumerate() {
        if v != 0 {
            img.put_pixel((i as u32) % w, (i as u32) / w, Luma([255]));
        }
    }
    img
}