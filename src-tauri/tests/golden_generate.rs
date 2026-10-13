//! 基准图 PNG 落盘与解码验证（Task 2, TR-2.1 / TR-2.2）。
//!
//! 运行 `cargo test --test golden_generate` 将 16 张基准图写到
//! `src-tauri/tests/golden_assets/`（16bit PNG，供人工查看与基线编码调试），
//! 并验证可被 image crate 正常解码回原始数据。

mod golden;

use golden::generator::{H, W, all_images};
use image::ImageEncoder as _;
use std::path::PathBuf;

fn assets_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden_assets")
}

fn encode_png(
    img: &golden::generator::GoldenImage,
) -> image::ImageBuffer<image::Rgb<u16>, Vec<u16>> {
    image::ImageBuffer::from_fn(W, H, |x, y| {
        let i = (y * W + x) as usize * 3;
        image::Rgb([img.data[i], img.data[i + 1], img.data[i + 2]])
    })
}

/// TR-2.1: PNG 编码路径幂等 —— 同一图两次写盘内容一致（PNG 编码器确定性）
#[test]
fn png_encode_is_deterministic() {
    let imgs = all_images();
    let first = encode_png(&imgs[0]);
    let mut buf1 = Vec::new();
    let mut buf2 = Vec::new();
    {
        let enc = image::codecs::png::PngEncoder::new(&mut buf1);
        enc.write_image(
            bytemuck::cast_slice(first.as_raw()),
            W,
            H,
            image::ExtendedColorType::Rgb16,
        )
        .expect("encode 1");
    }
    {
        let enc = image::codecs::png::PngEncoder::new(&mut buf2);
        enc.write_image(
            bytemuck::cast_slice(first.as_raw()),
            W,
            H,
            image::ExtendedColorType::Rgb16,
        )
        .expect("encode 2");
    }
    assert_eq!(buf1, buf2, "PNG encoding must be deterministic");
}

/// TR-2.2: 16 张全部生成 → 落盘 → 读回解码成功且数据还原一致
#[test]
fn generate_write_and_decode_all_16() {
    let dir = assets_dir();
    std::fs::create_dir_all(&dir).expect("create assets dir");

    let imgs = all_images();
    assert_eq!(imgs.len(), 16);

    for img in &imgs {
        let path = dir.join(format!("{}.png", img.id));
        let buffer = encode_png(img);
        buffer.save(&path).expect("save PNG");

        // 读回验证：解码成功 + 尺寸 + 像素数据一致（16bit 无损往返）
        let reloaded = image::ImageReader::open(&path)
            .expect("open PNG")
            .with_guessed_format()
            .expect("guess format")
            .decode()
            .unwrap_or_else(|e| panic!("decode {} failed: {e}", img.id));
        assert_eq!(reloaded.width(), W, "{}", img.id);
        assert_eq!(reloaded.height(), H, "{}", img.id);

        let rgb16 = reloaded.into_rgb16();
        for (i, px) in rgb16.as_raw().iter().enumerate() {
            assert_eq!(*px, img.data[i], "{} pixel {i} roundtrip mismatch", img.id);
        }
    }
}
