// R4-1: mip-pyramid bloom. Level 1 thresholds perceptual highlights (>= 0.85)
// in the toned display domain, then five downsampling stages feed a weighted
// composite (energy 1/2^n per level, normalized). The composite is sampled by
// the main pass at global coordinates, so tiles stay seam-free.

struct BloomParams {
    src_size: vec2<u32>,
    dst_size: vec2<u32>,
    is_raw: u32,
    _pad0: u32,
    exposure: f32,
    brightness: f32,
    contrast: f32,
    whites: f32,
    threshold: f32,
    _pad1: f32,
    _pad2: f32,
    _pad3: f32,
    _pad4: f32,
    _pad5: f32,
};

@group(0) @binding(0) var src_tex: texture_2d<f32>;
@group(0) @binding(1) var dst_tex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> params: BloomParams;
@group(0) @binding(3) var input_sampler: sampler;

const LUMA_COEFF = vec3<f32>(0.2126, 0.7152, 0.0722);

fn get_luma(c: vec3<f32>) -> f32 {
    return dot(c, LUMA_COEFF);
}

fn srgb_to_linear(c: vec3<f32>) -> vec3<f32> {
    let cutoff = vec3<f32>(0.04045);
    let higher = pow((c + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4));
    let lower = c / 12.92;
    return select(higher, lower, c <= cutoff);
}

fn apply_filmic_exposure(color_in: vec3<f32>, brightness_adj: f32) -> vec3<f32> {
    if (brightness_adj == 0.0) {
        return color_in;
    }
    const RATIONAL_CURVE_MIX: f32 = 0.95;
    const MIDTONE_STRENGTH: f32 = 1.2;
    let original_luma = get_luma(color_in);
    if (abs(original_luma) < 0.00001) {
        return color_in;
    }
    let direct_adj = brightness_adj * (1.0 - RATIONAL_CURVE_MIX);
    let rational_adj = brightness_adj * RATIONAL_CURVE_MIX;
    let scale = pow(2.0, direct_adj);
    let k = pow(2.0, -rational_adj * MIDTONE_STRENGTH);
    let luma_abs = abs(original_luma);
    let luma_floor = floor(luma_abs);
    let luma_fract = luma_abs - luma_floor;
    let shaped_fract = luma_fract / (luma_fract + (1.0 - luma_fract) * k);
    let shaped_luma_abs = luma_floor + shaped_fract;
    let new_luma = sign(original_luma) * shaped_luma_abs * scale;
    let chroma = color_in - vec3<f32>(original_luma);
    let total_luma_scale = new_luma / original_luma;
    let chroma_scale = pow(total_luma_scale, 0.8);
    return vec3<f32>(new_luma) + chroma * chroma_scale;
}

fn apply_tonal_adjustments(color: vec3<f32>, wh: f32) -> vec3<f32> {
    if (wh == 0.0) {
        return color;
    }
    let white_level = 1.0 - wh * 0.25;
    return color / max(white_level, 0.01);
}

fn tone_for_threshold(c: vec3<f32>, is_raw: u32, exp: f32, bright: f32, wh: f32) -> vec3<f32> {
    var lin = c;
    if (is_raw == 0u) { lin = srgb_to_linear(c); }
    lin = lin * pow(2.0, exp);
    lin = apply_filmic_exposure(lin, bright);
    lin = apply_tonal_adjustments(lin, wh);
    return lin;
}

@compute @workgroup_size(8, 8, 1)
fn down_main(@builtin(global_invocation_id) id: vec3<u32>) {
    let dst_dims = vec2<u32>(textureDimensions(dst_tex));
    if (id.x >= dst_dims.x || id.y >= dst_dims.y) { return; }

    let src_dims = vec2<f32>(params.src_size);
    let uv = (vec2<f32>(id.xy) + vec2<f32>(0.5)) / vec2<f32>(dst_dims);
    let half_px = vec2<f32>(0.5) / src_dims;

    let c00 = textureSampleLevel(src_tex, input_sampler, uv + vec2<f32>(-half_px.x, -half_px.y), 0.0).rgb;
    let c10 = textureSampleLevel(src_tex, input_sampler, uv + vec2<f32>(half_px.x, -half_px.y), 0.0).rgb;
    let c01 = textureSampleLevel(src_tex, input_sampler, uv + vec2<f32>(-half_px.x, half_px.y), 0.0).rgb;
    let c11 = textureSampleLevel(src_tex, input_sampler, uv + vec2<f32>(half_px.x, half_px.y), 0.0).rgb;
    var color = (c00 + c10 + c01 + c11) * 0.25;

    if (params.threshold > 0.0) {
        // Pyramid base: threshold perceptual highlights in the toned domain.
        let toned = tone_for_threshold(color, params.is_raw, params.exposure, params.brightness, params.whites);
        let linear_luma = get_luma(max(toned, vec3<f32>(0.0)));
        var perceptual_luma: f32;
        if (linear_luma <= 1.0) {
            perceptual_luma = pow(max(linear_luma, 0.0), 1.0 / 2.2);
        } else {
            perceptual_luma = 1.0 + pow(linear_luma - 1.0, 1.0 / 2.2);
        }
        let mask = smoothstep(params.threshold, params.threshold + 0.15, perceptual_luma);
        color = toned * mask;
    }

    textureStore(dst_tex, id.xy, vec4<f32>(color, 1.0));
}

@group(0) @binding(0) var comp_l1: texture_2d<f32>;
@group(0) @binding(1) var comp_l2: texture_2d<f32>;
@group(0) @binding(2) var comp_l3: texture_2d<f32>;
@group(0) @binding(3) var comp_l4: texture_2d<f32>;
@group(0) @binding(4) var comp_l5: texture_2d<f32>;
@group(0) @binding(5) var comp_dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(6) var<uniform> comp_params: BloomParams;
@group(0) @binding(7) var comp_sampler: sampler;

@compute @workgroup_size(8, 8, 1)
fn composite_main(@builtin(global_invocation_id) id: vec3<u32>) {
    let dst_dims = vec2<u32>(textureDimensions(comp_dst));
    if (id.x >= dst_dims.x || id.y >= dst_dims.y) { return; }

    let uv = (vec2<f32>(id.xy) + vec2<f32>(0.5)) / vec2<f32>(dst_dims);

    // Energy 1/2^n per pyramid level, normalized by the total weight.
    var w_sum = 0.0;
    var acc = vec3<f32>(0.0);

    let w1 = 1.0;
    let w2 = 0.5;
    let w3 = 0.25;
    let w4 = 0.125;
    let w5 = 0.0625;

    acc += textureSampleLevel(comp_l1, comp_sampler, uv, 0.0).rgb * w1;
    w_sum += w1;
    acc += textureSampleLevel(comp_l2, comp_sampler, uv, 0.0).rgb * w2;
    w_sum += w2;
    acc += textureSampleLevel(comp_l3, comp_sampler, uv, 0.0).rgb * w3;
    w_sum += w3;
    acc += textureSampleLevel(comp_l4, comp_sampler, uv, 0.0).rgb * w4;
    w_sum += w4;
    acc += textureSampleLevel(comp_l5, comp_sampler, uv, 0.0).rgb * w5;
    w_sum += w5;

    textureStore(comp_dst, id.xy, vec4<f32>(acc / max(w_sum, 1e-4), 1.0));
}
