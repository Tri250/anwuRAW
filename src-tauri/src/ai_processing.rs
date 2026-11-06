use std::collections::HashSet;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Result;
use image::imageops::{self, FilterType};
use image::{
    DynamicImage, GenericImageView, GrayImage, ImageBuffer, Luma, Rgb32FImage, RgbImage, RgbaImage,
};
use ndarray::{Array, Array4, ArrayViewD, IxDyn, s};
use ort::editor::{Graph, Model, Node, ONNX_DOMAIN, Opset, Outlet};
use ort::execution_providers::{CPUExecutionProvider, ExecutionProviderDispatch};
use ort::memory::Allocator;
use ort::session::{Output, Session};
use ort::tensor::{Shape, SymbolicDimensions, TensorElementType};
use ort::value::{Tensor, TensorRef, ValueType};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Emitter;
use tauri::Manager;
use tokenizers::Tokenizer;
use tokio::sync::Mutex as TokioMutex;

use crate::face_masking::FaceAnalysis;
use crate::model_registry::{self, ModelManifest, ModelSpec};
use crate::model_residency::{LoadedModel, ResidencyPolicy, ResidencyTracker};

const ENCODER_URL: &str = "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/sam_vit_b_01ec64_encoder.onnx?download=true";
const DECODER_URL: &str = "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/sam_vit_b_01ec64_decoder.onnx?download=true";
const ENCODER_FILENAME: &str = "sam_vit_b_01ec64_encoder.onnx";
const DECODER_FILENAME: &str = "sam_vit_b_01ec64_decoder.onnx";
const SAM_INPUT_SIZE: u32 = 1024;
const ENCODER_SHA256: &str = "16ab73d9c824886f0de2938c19df22fb9ec3deebfd0de58e65177e479213d7d1";
const DECODER_SHA256: &str = "85d0d672cf5b7fe763edcde429e5533e62f674af4b15c7d688b7673b0ef00bf7";

const BIREFNET_FP16_URL: &str = "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/birefnet_general_lite_fp16.onnx?download=true";
const BIREFNET_FP16_FILENAME: &str = "birefnet_general_lite_fp16.onnx";
const BIREFNET_FP16_SHA256: &str =
    "3b72cb3c2138605ced0a4b271e8d13d3b3ca2483cf1665b098b6851767420fa1";
const BIREFNET_FP32_URL: &str = "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/birefnet_general_lite.onnx?download=true";
const BIREFNET_FP32_FILENAME: &str = "birefnet_general_lite.onnx";
const BIREFNET_FP32_SHA256: &str =
    "5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333";
const BIREFNET_INPUT_SIZE: u32 = 1024;
const BIREFNET_ZOOM_MIN_IOU: f32 = 0.75;

const ZOOM_MARGIN: f32 = 0.15;
const ZOOM_MAX_FRACTION: f32 = 0.6;
const ZOOM_MIN_SIDE: f32 = 1024.0;
const ZOOM_FEATHER: f32 = 0.1;

const ESAM3_IMAGE_ENCODER_URL: &str = "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/efficientsam3_ev_m_image_encoder.onnx?download=true";
const ESAM3_IMAGE_ENCODER_FILENAME: &str = "efficientsam3_ev_m_image_encoder.onnx";
const ESAM3_IMAGE_ENCODER_SHA256: &str =
    "2ed08306579138120dbf9f1110fd31784d1c20fe1b67fa2187a0a2a6d7c82729";
const ESAM3_DECODER_URL: &str = "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/efficientsam3_ev_m_decoder.onnx?download=true";
const ESAM3_DECODER_FILENAME: &str = "efficientsam3_ev_m_decoder.onnx";
const ESAM3_DECODER_SHA256: &str =
    "16accc22a07ee99c73ef8a14e286ec567f94c116e0d8efa1a3a6c0bc9a2596a8";
const ESAM3_TEXT_ENCODER_URL: &str = "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/efficientsam3_ev_m_text_encoder.onnx?download=true";
const ESAM3_TEXT_ENCODER_FILENAME: &str = "efficientsam3_ev_m_text_encoder.onnx";
const ESAM3_TEXT_ENCODER_SHA256: &str =
    "3065ea6116f21f6e22bc70a0c041e5da9ae05fdec7b48df953394f5657609590";
const ESAM3_SKY_PROMPT_URL: &str = "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/efficientsam3_sky_prompt.bin?download=true";
const ESAM3_SKY_PROMPT_FILENAME: &str = "efficientsam3_sky_prompt.bin";
const ESAM3_SKY_PROMPT_SHA256: &str =
    "b8dc43661db640f2e3881466252d154906d90896eb3ed9dbc747bec87a97d180";
const ESAM3_FACE_PROMPT_URL: &str = "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/efficientsam3_face_prompt.bin?download=true";
const ESAM3_FACE_PROMPT_FILENAME: &str = "efficientsam3_face_prompt.bin";
const ESAM3_FACE_PROMPT_SHA256: &str =
    "8fdbe63ef853756b1da9cdc642c277a6e422452f3feaf35f4297e6aea3a1ffb9";
const ESAM3_INPUT_SIZE: u32 = 1008;
const ESAM3_INPUT_PADDING: u32 = 30;
const ESAM3_PROMPT_TOKENS: usize = 16;
const ESAM3_EMBED_DIM: usize = 256;
const ESAM3_EXEMPLAR_SLOTS: usize = 8;
pub const ESAM3_SKY_SCORE_THRESHOLD: f32 = 0.6;
pub const ESAM3_TEXT_SCORE_THRESHOLD: f32 = 0.3;
pub const ESAM3_FACE_SCORE_THRESHOLD: f32 = 0.3;
const ESAM3_MASK_LOW: f32 = 0.3;
const ESAM3_MASK_HIGH: f32 = 0.7;
/// P1-2：分位数自适应归一化的满值分位与下限口径。p99 作为"满值"刻度
/// （饱和顶部 1% 的极值忽略），p99 低于 ESAM3_MASK_LOW 视为无真实信号。
const MASK_PERCENTILE: f32 = 0.99;
const ESAM3_REFINE_SIZE: u32 = 1024;
const ESAM3_REFINE_RADIUS: usize = 16;
pub const ESAM3_SKY_REFINE_EPS: f32 = 0.001;
pub const ESAM3_TEXT_REFINE_EPS: f32 = 0.01;
/// P1-2：BiRefNet 前景掩膜 guided filter 贴边的 eps（与 ESAM3 天空管线
/// 同档：小 eps 让掩膜边界贴合亮度边缘，发丝/肩部获得软边）。
const BIREFNET_REFINE_EPS: f32 = 0.001;

/// P1-2：置信掩膜的分位数自适应归一化刻度——返回 Some(hi) 表示按
/// [0, hi] 线性归一，返回 None 表示无真实信号、调用方应维持固定阈值
/// 行为。hi 取掩膜自身 p99（select_nth_unstable，O(n)）。
/// 纯函数，便于测试。
fn percentile_mask_remap(values: &[f32]) -> Option<f32> {
    if values.is_empty() {
        return None;
    }
    let mut sorted = values.to_vec();
    let rank = ((values.len() - 1) as f32 * MASK_PERCENTILE).round() as usize;
    let (_, &mut hi, _) = sorted.select_nth_unstable_by(rank, |a, b| a.total_cmp(b));
    (hi > ESAM3_MASK_LOW).then_some(hi)
}
const ESAM3_ZOOM_MIN_IOU: f32 = 0.3;

const FACE_LANDMARKS_URL: &str = "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/mediapipe_face_landmarks.onnx?download=true";
const FACE_LANDMARKS_FILENAME: &str = "mediapipe_face_landmarks.onnx";
const FACE_LANDMARKS_SHA256: &str =
    "6524d596b4d9151b0d8d590844566261f21de5186ac38125bdcd1de6974b0bb4";
const FACE_SEGMENTER_URL: &str = "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/mediapipe_selfie_multiclass.onnx?download=true";
const FACE_SEGMENTER_FILENAME: &str = "mediapipe_selfie_multiclass.onnx";
const FACE_SEGMENTER_SHA256: &str =
    "a198470a4edec350a33b8182c149e417effc5e61c0506b947f226e7a81b9a08e";

const CLIP_MODEL_URL: &str =
    "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/clip_model.onnx?download=true";
const CLIP_MODEL_FILENAME: &str = "clip_model.onnx";
const CLIP_TOKENIZER_URL: &str = "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/clip_tokenizer.json?download=true";
const CLIP_TOKENIZER_FILENAME: &str = "clip_tokenizer.json";
const CLIP_MODEL_SHA256: &str = "57879bb1c23cdeb350d23569dd251ed4b740a96d747c529e94a2bb8040ac5d00";

const DENOISE_URL: &str = "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/nind_denoise_utnet_684.onnx?download=true";
const DENOISE_FILENAME: &str = "nind_denoise_utnet_684.onnx";
const DENOISE_SHA256: &str = "ee3586279d514df557ff3f7dec6df37fafc51ba5d3a3435b2cc9ac2d9017e7fe";

const LAMA_URL: &str =
    "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/lama_fp16.onnx?download=true";
const LAMA_FILENAME: &str = "lama_fp16.onnx";
const LAMA_SHA256: &str = "2d6be6277c400d6f1b91819737f7c3da935e5c63d1b521d393be1196a2bfa82c";

const DEPTH_URL: &str = "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/depth_anything_v2_vits.onnx?download=true";
const DEPTH_FILENAME: &str = "depth_anything_v2_vits.onnx";
const DEPTH_INPUT_SIZE: u32 = 518;
const DEPTH_SHA256: &str = "d2b11a11c1d4a12b47608fa65a17ee9a4c605b55ee1730c8e3b526304f2562be";

const NORMAL_URL: &str = "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/moge-2-vits-normal-onnx.onnx?download=true";
const NORMAL_FILENAME: &str = "moge-2-vits-normal-onnx.onnx";
const NORMAL_MAX_SIZE: u32 = 768;
const NORMAL_NUM_TOKENS: i64 = 2500;
const NORMAL_SHA256: &str = "24eacb5dc7a2c54c7bc98f7de085ffbed79ad006ea5b664c2c2cdc02ff3a52f0";

type SharedSession = Arc<Mutex<Session>>;

const GPU_IDLE: u8 = 0;
const GPU_ACTIVE: u8 = 1;
const GPU_FAILED: u8 = 2;
const GPU_DISABLED: u8 = 3;

static GPU_STATUS: AtomicU8 = AtomicU8::new(GPU_IDLE);

struct ModelAsset {
    filename: &'static str,
    url: &'static str,
    sha256: Option<&'static str>,
    name: &'static str,
}

const SAM_ENCODER_ASSET: ModelAsset = ModelAsset {
    filename: ENCODER_FILENAME,
    url: ENCODER_URL,
    sha256: Some(ENCODER_SHA256),
    name: "SAM Encoder",
};
const SAM_DECODER_ASSET: ModelAsset = ModelAsset {
    filename: DECODER_FILENAME,
    url: DECODER_URL,
    sha256: Some(DECODER_SHA256),
    name: "SAM Decoder",
};
const BIREFNET_FP16_ASSET: ModelAsset = ModelAsset {
    filename: BIREFNET_FP16_FILENAME,
    url: BIREFNET_FP16_URL,
    sha256: Some(BIREFNET_FP16_SHA256),
    name: "Foreground Model",
};
const BIREFNET_FP32_ASSET: ModelAsset = ModelAsset {
    filename: BIREFNET_FP32_FILENAME,
    url: BIREFNET_FP32_URL,
    sha256: Some(BIREFNET_FP32_SHA256),
    name: "Foreground Model",
};
const ESAM3_IMAGE_ENCODER_ASSET: ModelAsset = ModelAsset {
    filename: ESAM3_IMAGE_ENCODER_FILENAME,
    url: ESAM3_IMAGE_ENCODER_URL,
    sha256: Some(ESAM3_IMAGE_ENCODER_SHA256),
    name: "EfficientSAM3 Encoder",
};
const ESAM3_DECODER_ASSET: ModelAsset = ModelAsset {
    filename: ESAM3_DECODER_FILENAME,
    url: ESAM3_DECODER_URL,
    sha256: Some(ESAM3_DECODER_SHA256),
    name: "EfficientSAM3 Decoder",
};
const ESAM3_TEXT_ENCODER_ASSET: ModelAsset = ModelAsset {
    filename: ESAM3_TEXT_ENCODER_FILENAME,
    url: ESAM3_TEXT_ENCODER_URL,
    sha256: Some(ESAM3_TEXT_ENCODER_SHA256),
    name: "EfficientSAM3 Text Encoder",
};
const ESAM3_SKY_PROMPT_ASSET: ModelAsset = ModelAsset {
    filename: ESAM3_SKY_PROMPT_FILENAME,
    url: ESAM3_SKY_PROMPT_URL,
    sha256: Some(ESAM3_SKY_PROMPT_SHA256),
    name: "Sky Prompt",
};
const ESAM3_FACE_PROMPT_ASSET: ModelAsset = ModelAsset {
    filename: ESAM3_FACE_PROMPT_FILENAME,
    url: ESAM3_FACE_PROMPT_URL,
    sha256: Some(ESAM3_FACE_PROMPT_SHA256),
    name: "Face Prompt",
};
const FACE_LANDMARKS_ASSET: ModelAsset = ModelAsset {
    filename: FACE_LANDMARKS_FILENAME,
    url: FACE_LANDMARKS_URL,
    sha256: Some(FACE_LANDMARKS_SHA256),
    name: "Face Landmarks Model",
};
const FACE_SEGMENTER_ASSET: ModelAsset = ModelAsset {
    filename: FACE_SEGMENTER_FILENAME,
    url: FACE_SEGMENTER_URL,
    sha256: Some(FACE_SEGMENTER_SHA256),
    name: "Face Segmentation Model",
};
const DEPTH_ASSET: ModelAsset = ModelAsset {
    filename: DEPTH_FILENAME,
    url: DEPTH_URL,
    sha256: Some(DEPTH_SHA256),
    name: "Depth Model",
};
const CLIP_MODEL_ASSET: ModelAsset = ModelAsset {
    filename: CLIP_MODEL_FILENAME,
    url: CLIP_MODEL_URL,
    sha256: Some(CLIP_MODEL_SHA256),
    name: "CLIP Model",
};
const CLIP_TOKENIZER_ASSET: ModelAsset = ModelAsset {
    filename: CLIP_TOKENIZER_FILENAME,
    url: CLIP_TOKENIZER_URL,
    sha256: None,
    name: "CLIP Tokenizer",
};
const DENOISE_ASSET: ModelAsset = ModelAsset {
    filename: DENOISE_FILENAME,
    url: DENOISE_URL,
    sha256: Some(DENOISE_SHA256),
    name: "NIND Denoise Model",
};
const LAMA_ASSET: ModelAsset = ModelAsset {
    filename: LAMA_FILENAME,
    url: LAMA_URL,
    sha256: Some(LAMA_SHA256),
    name: "Inpainting Model",
};
const NORMAL_ASSET: ModelAsset = ModelAsset {
    filename: NORMAL_FILENAME,
    url: NORMAL_URL,
    sha256: Some(NORMAL_SHA256),
    name: "Normal Model",
};

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum AiMaskModel {
    Subject,
    Foreground,
    Sky,
    Text,
    Face,
    Depth,
}

impl AiMaskModel {
    fn assets(self, gpu_inference: bool) -> &'static [ModelAsset] {
        match self {
            AiMaskModel::Subject => &[SAM_ENCODER_ASSET, SAM_DECODER_ASSET],
            AiMaskModel::Foreground if gpu_inference => &[BIREFNET_FP16_ASSET],
            AiMaskModel::Foreground => &[BIREFNET_FP32_ASSET],
            AiMaskModel::Sky => &[
                ESAM3_IMAGE_ENCODER_ASSET,
                ESAM3_DECODER_ASSET,
                ESAM3_SKY_PROMPT_ASSET,
            ],
            AiMaskModel::Text => &[
                ESAM3_IMAGE_ENCODER_ASSET,
                ESAM3_DECODER_ASSET,
                ESAM3_TEXT_ENCODER_ASSET,
                CLIP_TOKENIZER_ASSET,
            ],
            AiMaskModel::Face => &[
                ESAM3_IMAGE_ENCODER_ASSET,
                ESAM3_DECODER_ASSET,
                ESAM3_FACE_PROMPT_ASSET,
                FACE_LANDMARKS_ASSET,
                FACE_SEGMENTER_ASSET,
            ],
            AiMaskModel::Depth => &[DEPTH_ASSET],
        }
    }
}

pub struct Esam3Features {
    pub path_hash: String,
    pub fpn: [Array<f32, IxDyn>; 3],
    pub pos: Array<f32, IxDyn>,
}

pub struct Esam3Prompt {
    features: Array<f32, IxDyn>,
    padding: Array<f32, IxDyn>,
}

/// BiRefNet fp16/fp32 share a single session slot, so residency tracks both
/// variants under one key.
const BIREFNET_RESIDENCY_KEY: &str = "birefnet";

fn residency_key(filename: &str) -> &str {
    match filename {
        BIREFNET_FP16_FILENAME | BIREFNET_FP32_FILENAME => BIREFNET_RESIDENCY_KEY,
        other => other,
    }
}

pub struct AiModels {
    models_dir: PathBuf,
    use_gpu: bool,
    downloaded: Mutex<HashSet<AiMaskModel>>,
    sam_encoder: Mutex<Option<SharedSession>>,
    sam_decoder: Mutex<Option<SharedSession>>,
    birefnet: Mutex<Option<SharedSession>>,
    esam3_image_encoder: Mutex<Option<SharedSession>>,
    esam3_decoder: Mutex<Option<SharedSession>>,
    esam3_text_encoder: Mutex<Option<SharedSession>>,
    esam3_sky_prompt: Mutex<Option<Arc<Esam3Prompt>>>,
    esam3_face_prompt: Mutex<Option<Arc<Esam3Prompt>>>,
    clip_tokenizer: Mutex<Option<Arc<Tokenizer>>>,
    face_landmarks: Mutex<Option<SharedSession>>,
    face_segmenter: Mutex<Option<SharedSession>>,
    depth_anything: Mutex<Option<SharedSession>>,
    residency: Mutex<ResidencyTracker>,
    residency_epoch: Instant,
}

impl AiModels {
    fn now_secs(&self) -> u64 {
        self.residency_epoch.elapsed().as_secs()
    }

    fn touch_residency(&self, filename: &str) {
        let key = residency_key(filename);
        let now = self.now_secs();
        self.residency.lock().unwrap().touch(key, now);
    }

    fn session(
        &self,
        slot: &Mutex<Option<SharedSession>>,
        filename: &str,
        use_gpu: bool,
    ) -> Result<SharedSession> {
        // Reclaim idle/over-budget sessions before building another one. This
        // runs before `slot` is locked so the eviction path never nests locks.
        self.enforce_residency(filename);
        let mut slot = slot.lock().unwrap();
        if let Some(session) = slot.as_ref() {
            let session = Arc::clone(session);
            drop(slot);
            self.touch_residency(filename);
            return Ok(session);
        }
        let session = Arc::new(Mutex::new(build_session(
            &self.models_dir.join(filename),
            SessionKind::OneShot,
            self.use_gpu && use_gpu,
            None,
        )?));
        *slot = Some(Arc::clone(&session));
        drop(slot);
        self.touch_residency(filename);
        Ok(session)
    }

    /// Drops sessions the residency policy flags as idle or over budget,
    /// except `keep` (the model the caller is about to use). Returns what was
    /// released; consumers may log it or surface it in diagnostics.
    fn enforce_residency(&self, keep: &str) -> Vec<String> {
        let keep = residency_key(keep);
        let due = {
            let tracker = self.residency.lock().unwrap();
            let reserve = if tracker.is_loaded(keep) { 0 } else { 1 };
            tracker.due_for_eviction_reserving(self.now_secs(), reserve)
        };
        let mut released = Vec::new();
        for key in due {
            if key == keep {
                continue;
            }
            if self.evict_slot(&key) {
                self.residency.lock().unwrap().mark_released(&key);
                released.push(key);
            }
        }
        released
    }

    fn evict_slot(&self, key: &str) -> bool {
        let session_slot = match key {
            ENCODER_FILENAME => Some(&self.sam_encoder),
            DECODER_FILENAME => Some(&self.sam_decoder),
            BIREFNET_RESIDENCY_KEY => Some(&self.birefnet),
            ESAM3_IMAGE_ENCODER_FILENAME => Some(&self.esam3_image_encoder),
            ESAM3_DECODER_FILENAME => Some(&self.esam3_decoder),
            ESAM3_TEXT_ENCODER_FILENAME => Some(&self.esam3_text_encoder),
            FACE_LANDMARKS_FILENAME => Some(&self.face_landmarks),
            FACE_SEGMENTER_FILENAME => Some(&self.face_segmenter),
            DEPTH_FILENAME => Some(&self.depth_anything),
            // Prompt embeddings are a few kilobytes and are deliberately left
            // out of the residency budget.
            _ => None,
        };
        session_slot.is_some_and(|slot| slot.lock().unwrap().take().is_some())
    }

    pub fn residency_snapshot(&self) -> Vec<LoadedModel> {
        let tracker = self.residency.lock().unwrap();
        tracker.loaded(self.now_secs())
    }

    pub fn sam_encoder(&self) -> Result<SharedSession> {
        self.session(&self.sam_encoder, ENCODER_FILENAME, false)
    }

    pub fn sam_decoder(&self) -> Result<SharedSession> {
        self.session(&self.sam_decoder, DECODER_FILENAME, false)
    }

    fn gpu_inference(&self) -> bool {
        self.use_gpu && gpu_allowed_on_platform() && gpu_execution_provider().is_some()
    }

    pub fn birefnet(&self) -> Result<SharedSession> {
        let filename = if self.gpu_inference() {
            BIREFNET_FP16_FILENAME
        } else {
            BIREFNET_FP32_FILENAME
        };
        self.session(&self.birefnet, filename, gpu_allowed_on_platform())
    }

    pub fn esam3_image_encoder(&self) -> Result<SharedSession> {
        self.session(
            &self.esam3_image_encoder,
            ESAM3_IMAGE_ENCODER_FILENAME,
            gpu_allowed_on_platform(),
        )
    }

    pub fn esam3_decoder(&self) -> Result<SharedSession> {
        self.session(
            &self.esam3_decoder,
            ESAM3_DECODER_FILENAME,
            gpu_allowed_on_platform(),
        )
    }

    pub fn depth_anything(&self) -> Result<SharedSession> {
        self.session(&self.depth_anything, DEPTH_FILENAME, true)
    }

    pub fn face_landmarks(&self) -> Result<SharedSession> {
        self.session(&self.face_landmarks, FACE_LANDMARKS_FILENAME, false)
    }

    pub fn face_segmenter(&self) -> Result<SharedSession> {
        self.session(&self.face_segmenter, FACE_SEGMENTER_FILENAME, false)
    }

    pub fn esam3_sky_prompt(&self) -> Result<Arc<Esam3Prompt>> {
        self.stored_prompt(&self.esam3_sky_prompt, ESAM3_SKY_PROMPT_FILENAME)
    }

    pub fn esam3_face_prompt(&self) -> Result<Arc<Esam3Prompt>> {
        self.stored_prompt(&self.esam3_face_prompt, ESAM3_FACE_PROMPT_FILENAME)
    }

    fn stored_prompt(
        &self,
        slot: &Mutex<Option<Arc<Esam3Prompt>>>,
        filename: &str,
    ) -> Result<Arc<Esam3Prompt>> {
        let mut slot = slot.lock().unwrap();
        if let Some(prompt) = slot.as_ref() {
            return Ok(Arc::clone(prompt));
        }
        let bytes = fs::read(self.models_dir.join(filename))?;
        let values: Vec<f32> = bytes
            .as_chunks::<4>()
            .0
            .iter()
            .map(|&chunk| f32::from_le_bytes(chunk))
            .collect();
        let feature_len = ESAM3_PROMPT_TOKENS * ESAM3_EMBED_DIM;
        if values.len() != feature_len + ESAM3_PROMPT_TOKENS {
            return Err(anyhow::anyhow!("Invalid prompt embedding {}", filename));
        }
        let prompt = Arc::new(Esam3Prompt {
            features: Array::from_shape_vec(
                IxDyn(&[ESAM3_PROMPT_TOKENS, 1, ESAM3_EMBED_DIM]),
                values[..feature_len].to_vec(),
            )?,
            padding: Array::from_shape_vec(
                IxDyn(&[1, ESAM3_PROMPT_TOKENS]),
                values[feature_len..].to_vec(),
            )?,
        });
        *slot = Some(Arc::clone(&prompt));
        Ok(prompt)
    }

    pub fn esam3_text_prompt(&self, text: &str) -> Result<Esam3Prompt> {
        let tokenizer = {
            let mut slot = self.clip_tokenizer.lock().unwrap();
            match slot.as_ref() {
                Some(tokenizer) => Arc::clone(tokenizer),
                None => {
                    let tokenizer = Arc::new(
                        Tokenizer::from_file(self.models_dir.join(CLIP_TOKENIZER_FILENAME))
                            .map_err(|e| anyhow::anyhow!(e.to_string()))?,
                    );
                    *slot = Some(Arc::clone(&tokenizer));
                    tokenizer
                }
            }
        };
        let encoding = tokenizer
            .encode(text.trim(), true)
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        let ids = encoding.get_ids();
        let mut tokens = Array::<i64, _>::zeros((1, ESAM3_PROMPT_TOKENS));
        let kept = ids.len().min(ESAM3_PROMPT_TOKENS);
        for (i, &id) in ids[..kept].iter().enumerate() {
            tokens[[0, i]] = id as i64;
        }
        if let Some(&end) = ids.last()
            && ids.len() > ESAM3_PROMPT_TOKENS
        {
            tokens[[0, ESAM3_PROMPT_TOKENS - 1]] = end as i64;
        }

        let session = self.session(&self.esam3_text_encoder, ESAM3_TEXT_ENCODER_FILENAME, false)?;
        let mut session = session.lock().unwrap();
        let outputs = session.run(ort::inputs!["tokens" => Tensor::from_array(tokens)?])?;
        Ok(Esam3Prompt {
            features: outputs["language_features"]
                .try_extract_array::<f32>()?
                .to_owned(),
            padding: outputs["language_padding"]
                .try_extract_array::<f32>()?
                .to_owned(),
        })
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SessionKind {
    OneShot,
    Persistent,
}

#[cfg(target_os = "windows")]
fn high_performance_dml_device_id() -> Option<i32> {
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory2, DXGI_CREATE_FACTORY_FLAGS, DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE,
        IDXGIAdapter1, IDXGIFactory6,
    };

    unsafe {
        let factory: IDXGIFactory6 = CreateDXGIFactory2(DXGI_CREATE_FACTORY_FLAGS(0)).ok()?;
        let preferred: IDXGIAdapter1 = factory
            .EnumAdapterByGpuPreference(0, DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE)
            .ok()?;
        let luid = preferred.GetDesc1().ok()?.AdapterLuid;
        (0..)
            .map_while(|i| factory.EnumAdapters1(i).ok())
            .position(|adapter| {
                adapter
                    .GetDesc1()
                    .is_ok_and(|desc| desc.AdapterLuid == luid)
            })
            .map(|index| index as i32)
    }
}

#[cfg(target_os = "windows")]
fn gpu_execution_provider() -> Option<ExecutionProviderDispatch> {
    Some(
        ort::execution_providers::DirectMLExecutionProvider::default()
            .with_device_id(high_performance_dml_device_id().unwrap_or(0))
            .build()
            .error_on_failure(),
    )
}

#[cfg(target_os = "macos")]
fn gpu_execution_provider() -> Option<ExecutionProviderDispatch> {
    use ort::execution_providers::coreml::{CoreMLComputeUnits, CoreMLModelFormat};

    Some(
        ort::execution_providers::CoreMLExecutionProvider::default()
            .with_model_format(CoreMLModelFormat::MLProgram)
            .with_compute_units(CoreMLComputeUnits::All)
            .build()
            .error_on_failure(),
    )
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn gpu_execution_provider() -> Option<ExecutionProviderDispatch> {
    None
}

fn gpu_allowed_on_platform() -> bool {
    !cfg!(target_os = "macos")
}

type GpuModelPatch = fn() -> ort::Result<(Model, Vec<Output>)>;

fn i64_initializer(values: &[i64]) -> ort::Result<Tensor<i64>> {
    let mut tensor = Tensor::<i64>::new(&Allocator::default(), [values.len()])?;
    tensor.extract_tensor_mut().1.copy_from_slice(values);
    Ok(tensor)
}

fn denoise_crop_as_slice() -> ort::Result<(Model, Vec<Output>)> {
    let output_type = ValueType::Tensor {
        ty: TensorElementType::Float32,
        shape: Shape::new([1, 3, -1, -1]),
        dimension_symbols: SymbolicDimensions::empty(4),
    };

    let mut graph = Graph::new()?;
    graph.add_initializer("crop_starts", i64_initializer(&[2, 2])?, false)?;
    graph.add_initializer("crop_ends", i64_initializer(&[-2, -2])?, false)?;
    graph.add_initializer("crop_axes", i64_initializer(&[2, 3])?, false)?;
    graph.add_node(Node::new(
        "Slice",
        ONNX_DOMAIN,
        "crop_slice",
        ["conv2d_9", "crop_starts", "crop_ends", "crop_axes"],
        ["denoised"],
        [],
    )?)?;
    graph.set_outputs([Outlet::new("denoised", &output_type)?])?;

    let mut model = Model::new([Opset::new(ONNX_DOMAIN, 18)?])?;
    model.add_graph(graph)?;
    Ok((
        model,
        vec![Output {
            name: "denoised".to_string(),
            output_type,
        }],
    ))
}

fn create_session(
    model_path: &Path,
    kind: SessionKind,
    gpu_provider: Option<ExecutionProviderDispatch>,
    gpu_patch: Option<GpuModelPatch>,
) -> Result<Session> {
    let use_gpu = gpu_provider.is_some();
    let cpu_provider = CPUExecutionProvider::default()
        .with_arena_allocator(kind == SessionKind::Persistent)
        .build();
    let providers: Vec<_> = gpu_provider.into_iter().chain([cpu_provider]).collect();

    let mut builder = Session::builder()?;
    // P0-2：Android 按机型档位限制 intra-op 线程（1~2，防发热与热节流）；
    // 桌面端 mobile_intra_threads() 为 None，保持 ORT 默认不变。
    // 注：若 ORT 本体以 OpenMP 构建，该设置不生效（ort 文档口径），
    // 本项目 Android 使用官方预编译 libonnxruntime.so。
    if let Some(threads) = crate::ai_perf::mobile_intra_threads() {
        builder = builder.with_intra_threads(threads)?;
    }
    if use_gpu || kind == SessionKind::OneShot {
        builder = builder.with_memory_pattern(false)?;
    }
    if use_gpu && kind == SessionKind::OneShot {
        builder = builder.with_config_entry("ep.dml.disable_memory_arena", "1")?;
    }
    let builder = builder.with_execution_providers(providers)?;
    match gpu_patch {
        Some(patch) => {
            let (model, outputs) = patch()?;
            let mut session = builder.edit_from_file(model_path)?;
            session.apply_model(&model)?;
            let mut session = session.into_session()?;
            session.outputs = outputs;
            Ok(session)
        }
        None => Ok(builder.commit_from_file(model_path)?),
    }
}

fn build_session(
    model_path: &Path,
    kind: SessionKind,
    use_gpu: bool,
    gpu_patch: Option<GpuModelPatch>,
) -> Result<Session> {
    if use_gpu
        && GPU_STATUS.load(Ordering::Acquire) < GPU_FAILED
        && let Some(gpu_provider) = gpu_execution_provider()
    {
        match create_session(model_path, kind, Some(gpu_provider), gpu_patch) {
            Ok(session) => {
                let _ = GPU_STATUS.compare_exchange(
                    GPU_IDLE,
                    GPU_ACTIVE,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                );
                return Ok(session);
            }
            Err(e) => log::warn!(
                "GPU acceleration unavailable for {}, falling back to CPU: {}",
                model_path.display(),
                e
            ),
        }
    }
    create_session(model_path, kind, None, None)
}

pub fn gpu_acceleration_enabled(app_handle: &tauri::AppHandle) -> bool {
    GPU_STATUS.load(Ordering::Acquire) < GPU_FAILED
        && crate::app_settings::load_settings(app_handle.clone())
            .map(|settings| settings.ai_gpu_acceleration)
            .unwrap_or(true)
}

pub fn gpu_inference<T>(result: ort::Result<T>) -> Result<T> {
    result.map_err(|e| {
        if GPU_STATUS
            .compare_exchange(GPU_ACTIVE, GPU_FAILED, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            log::warn!(
                "GPU inference failed, using the CPU for AI models from now on: {}",
                e
            );
        }
        e.into()
    })
}

pub fn reset_ai_sessions(ai_state_mutex: &Mutex<Option<AiState>>) {
    if let Some(ai_state) = ai_state_mutex.lock().unwrap().as_mut() {
        ai_state.release_sessions();
    }
    GPU_STATUS.store(GPU_IDLE, Ordering::Release);
}

pub struct ClipModels {
    pub model: Mutex<Session>,
    pub tokenizer: Tokenizer,
}

#[derive(Clone)]
pub struct ImageEmbeddings {
    pub path_hash: String,
    pub embeddings: Array<f32, IxDyn>,
    pub original_size: (u32, u32),
}

#[derive(Clone)]
pub struct CachedDepthMap {
    pub path_hash: String,
    pub depth_image: GrayImage,
    pub original_size: (u32, u32),
}

pub struct AiState {
    pub models: Option<Arc<AiModels>>,
    pub denoise_model: Option<Arc<Mutex<Session>>>,
    pub clip_models: Option<Arc<ClipModels>>,
    pub lama_model: Option<Arc<Mutex<Session>>>,
    pub normal_model: Option<Arc<Mutex<Session>>>,
    pub embeddings: Option<ImageEmbeddings>,
    pub esam3_features: Option<Arc<Esam3Features>>,
    pub face_analysis: Option<Arc<FaceAnalysis>>,
    pub depth_map: Option<CachedDepthMap>,
    residency: ResidencyTracker,
}

impl Default for AiState {
    fn default() -> Self {
        Self {
            models: None,
            denoise_model: None,
            clip_models: None,
            lama_model: None,
            normal_model: None,
            embeddings: None,
            esam3_features: None,
            face_analysis: None,
            depth_map: None,
            residency: ResidencyTracker::new(ResidencyPolicy::idle_only(cfg!(
                target_os = "android"
            ))),
        }
    }
}

impl AiState {
    pub fn release_sessions(&mut self) {
        self.models = None;
        self.denoise_model = None;
        self.clip_models = None;
        self.lama_model = None;
        self.normal_model = None;
        self.residency.clear();
    }

    fn touch_model(&mut self, key: &str) {
        let now = uptime_secs();
        self.residency.touch(key, now);
    }

    fn enforce_model_residency(&mut self, keep: &str) {
        let now = uptime_secs();
        let reserve = if self.residency.is_loaded(keep) { 0 } else { 1 };
        let due = self.residency.due_for_eviction_reserving(now, reserve);
        for key in due {
            if key == keep {
                continue;
            }
            let freed = match key.as_str() {
                DENOISE_FILENAME => self.denoise_model.take().is_some(),
                CLIP_MODEL_FILENAME => self.clip_models.take().is_some(),
                LAMA_FILENAME => self.lama_model.take().is_some(),
                NORMAL_FILENAME => self.normal_model.take().is_some(),
                _ => false,
            };
            if freed {
                self.residency.mark_released(&key);
            }
        }
    }
}

fn cached_ai_state<T>(
    ai_state_mutex: &Mutex<Option<AiState>>,
    get: impl Fn(&AiState) -> Option<T>,
) -> Option<T> {
    let mut ai_state = ai_state_mutex.lock().unwrap();
    if GPU_STATUS
        .compare_exchange(
            GPU_FAILED,
            GPU_DISABLED,
            Ordering::AcqRel,
            Ordering::Acquire,
        )
        .is_ok()
        && let Some(ai_state) = ai_state.as_mut()
    {
        ai_state.release_sessions();
    }
    ai_state.as_ref().and_then(get)
}

fn uptime_secs() -> u64 {
    static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs()
}

fn touch_state_model(ai_state_mutex: &Mutex<Option<AiState>>, key: &str) {
    if let Some(state) = ai_state_mutex.lock().unwrap().as_mut() {
        state.touch_model(key);
    }
}

fn enforce_state_residency(ai_state_mutex: &Mutex<Option<AiState>>, keep: &str) {
    let mut guard = ai_state_mutex.lock().unwrap();
    guard
        .get_or_insert_with(AiState::default)
        .enforce_model_residency(keep);
}

fn edt_1d(f: &mut [f32], v: &mut [usize], z: &mut [f32], d: &mut [f32]) {
    let n = f.len();
    if n == 0 {
        return;
    }
    let mut k = 0;
    v[0] = 0;
    z[0] = f32::NEG_INFINITY;
    z[1] = f32::INFINITY;
    for q in 1..n {
        let mut s = ((f[q] + (q * q) as f32) - (f[v[k]] + (v[k] * v[k]) as f32))
            / (2.0 * (q as f32 - v[k] as f32));
        while s <= z[k] {
            if k == 0 {
                break;
            }
            k -= 1;
            s = ((f[q] + (q * q) as f32) - (f[v[k]] + (v[k] * v[k]) as f32))
                / (2.0 * (q as f32 - v[k] as f32));
        }
        k += 1;
        v[k] = q;
        z[k] = s;
        z[k + 1] = f32::INFINITY;
    }
    k = 0;
    for (q, d_q) in d[..n].iter_mut().enumerate() {
        while z[k + 1] < q as f32 {
            k += 1;
        }
        let diff = q as f32 - v[k] as f32;
        *d_q = diff * diff + f[v[k]];
    }
    f.copy_from_slice(&d[..n]);
}

fn edt_2d(grid: &[bool], width: usize, height: usize) -> Vec<f32> {
    let area = width * height;
    let mut f = vec![0.0; area];
    for i in 0..area {
        f[i] = if grid[i] { 1e10 } else { 0.0 };
    }

    let max_dim = width.max(height);
    let mut v = vec![0; max_dim];
    let mut z = vec![0.0; max_dim + 1];
    let mut d = vec![0.0; max_dim];

    for y in 0..height {
        let start = y * width;
        let end = start + width;
        edt_1d(&mut f[start..end], &mut v, &mut z, &mut d);
    }

    let mut col = vec![0.0; height];
    for x in 0..width {
        for y in 0..height {
            col[y] = f[y * width + x];
        }
        edt_1d(&mut col, &mut v, &mut z, &mut d);
        for y in 0..height {
            f[y * width + x] = col[y];
        }
    }

    f.into_iter().map(|v| v.sqrt()).collect()
}

fn box_filter_horiz(src: &[f32], dest: &mut [f32], w: usize, r: usize) {
    dest.par_chunks_exact_mut(w)
        .zip(src.par_chunks_exact(w))
        .for_each(|(dest_row, src_row)| {
            let mut prefix = vec![0.0; w + 1];
            for x in 0..w {
                prefix[x + 1] = prefix[x] + src_row[x];
            }
            for (x, dest_val) in dest_row.iter_mut().enumerate() {
                let x_min = x.saturating_sub(r);
                let x_max = (x + r).min(w - 1);
                let count = (x_max - x_min + 1) as f32;
                *dest_val = (prefix[x_max + 1] - prefix[x_min]) / count;
            }
        });
}

fn transpose(src: &[f32], dest: &mut [f32], w: usize, h: usize) {
    dest.par_chunks_exact_mut(h)
        .enumerate()
        .for_each(|(x, dest_col)| {
            for y in 0..h {
                dest_col[y] = src[y * w + x];
            }
        });
}

fn box_filter_opt(
    src: &[f32],
    dest: &mut [f32],
    temp1: &mut [f32],
    temp2: &mut [f32],
    w: usize,
    h: usize,
    r: usize,
) {
    box_filter_horiz(src, temp1, w, r);
    transpose(temp1, temp2, w, h);
    box_filter_horiz(temp2, temp1, h, r);
    transpose(temp1, dest, h, w);
}

pub fn fast_guided_filter(
    guide_hr: &GrayImage,
    mask_lr: &GrayImage,
    r: usize,
    eps: f32,
) -> GrayImage {
    let (hr_w, hr_h) = guide_hr.dimensions();
    let (lr_w, lr_h) = mask_lr.dimensions();

    let w = lr_w as usize;
    let h = lr_h as usize;
    let area = w * h;

    let guide_lr = if (lr_w, lr_h) == (hr_w, hr_h) {
        std::borrow::Cow::Borrowed(guide_hr)
    } else {
        std::borrow::Cow::Owned(imageops::resize(guide_hr, lr_w, lr_h, FilterType::Triangle))
    };

    let mut i_lr = vec![0.0; area];
    let mut p_lr = vec![0.0; area];
    let mut ip_lr = vec![0.0; area];
    let mut ii_lr = vec![0.0; area];

    let guide_lr_raw = guide_lr.as_raw();
    let mask_lr_raw = mask_lr.as_raw();

    i_lr.par_iter_mut()
        .zip(p_lr.par_iter_mut())
        .zip(ip_lr.par_iter_mut())
        .zip(ii_lr.par_iter_mut())
        .zip(guide_lr_raw.par_iter())
        .zip(mask_lr_raw.par_iter())
        .for_each(|(((((i_out, p_out), ip_out), ii_out), &g_val), &m_val)| {
            let i_val = g_val as f32 / 255.0;
            let p_val = m_val as f32 / 255.0;
            *i_out = i_val;
            *p_out = p_val;
            *ip_out = i_val * p_val;
            *ii_out = i_val * i_val;
        });

    drop(guide_lr);

    let mut temp1 = vec![0.0; area];
    let mut temp2 = vec![0.0; area];

    let box_filter = |src: Vec<f32>, temp1: &mut [f32], temp2: &mut [f32]| {
        let mut mean = vec![0.0; area];
        box_filter_opt(&src, &mut mean, temp1, temp2, w, h, r);
        mean
    };
    let mean_i = box_filter(i_lr, &mut temp1, &mut temp2);
    let mean_p = box_filter(p_lr, &mut temp1, &mut temp2);
    let mut a = box_filter(ip_lr, &mut temp1, &mut temp2);
    let mut b = box_filter(ii_lr, &mut temp1, &mut temp2);

    a.par_iter_mut()
        .zip(b.par_iter_mut())
        .zip(mean_i.par_iter())
        .zip(mean_p.par_iter())
        .for_each(|(((a_out, b_out), &m_i), &m_p)| {
            let (m_ip, m_ii) = (*a_out, *b_out);
            let cov_ip = m_ip - m_i * m_p;
            let var_i = m_ii - m_i * m_i;
            let a_val = cov_ip / (var_i + eps);
            *a_out = a_val;
            *b_out = m_p - a_val * m_i;
        });

    let (mut mean_a, mut mean_b) = (mean_i, mean_p);
    box_filter_opt(&a, &mut mean_a, &mut temp1, &mut temp2, w, h, r);
    box_filter_opt(&b, &mut mean_b, &mut temp1, &mut temp2, w, h, r);
    drop((a, b, temp1, temp2));

    let mean_a_img = ImageBuffer::<Luma<f32>, Vec<f32>>::from_raw(lr_w, lr_h, mean_a).unwrap();
    let mean_b_img = ImageBuffer::<Luma<f32>, Vec<f32>>::from_raw(lr_w, lr_h, mean_b).unwrap();

    let upscale = |img: ImageBuffer<Luma<f32>, Vec<f32>>| {
        if (lr_w, lr_h) == (hr_w, hr_h) {
            img.into_raw()
        } else {
            imageops::resize(&img, hr_w, hr_h, FilterType::Triangle).into_raw()
        }
    };
    let mean_a_hr_raw = upscale(mean_a_img);
    let mean_b_hr_raw = upscale(mean_b_img);
    let guide_hr_raw = guide_hr.as_raw();

    let mut final_mask_raw = vec![0u8; (hr_w * hr_h) as usize];

    final_mask_raw
        .par_iter_mut()
        .zip(mean_a_hr_raw.par_iter())
        .zip(mean_b_hr_raw.par_iter())
        .zip(guide_hr_raw.par_iter())
        .for_each(|(((out, &a_val), &b_val), &i_val)| {
            let i_v = i_val as f32 / 255.0;
            let q = a_val * i_v + b_val;
            *out = (q.clamp(0.0, 1.0) * 255.0).round() as u8;
        });

    GrayImage::from_raw(hr_w, hr_h, final_mask_raw).unwrap()
}

fn bilinear_sample(i: usize, scale: f32, n: usize) -> (usize, usize, f32) {
    let f = ((i as f32 + 0.5) * scale - 0.5).max(0.0);
    let i0 = (f.floor() as usize).min(n - 1);
    let i1 = (i0 + 1).min(n - 1);
    (i0, i1, (f - i0 as f32).clamp(0.0, 1.0))
}

pub fn fast_color_guided_filter(
    guide_hr: &RgbImage,
    mask_lr: &GrayImage,
    r: usize,
    eps: f32,
) -> GrayImage {
    let (hr_w, hr_h) = guide_hr.dimensions();
    let (lr_w, lr_h) = mask_lr.dimensions();
    let (w, h) = (lr_w as usize, lr_h as usize);
    let area = w * h;

    let guide_lr = imageops::resize(guide_hr, lr_w, lr_h, FilterType::Triangle);
    let guide: [Vec<f32>; 3] =
        std::array::from_fn(|c| guide_lr.pixels().map(|p| p[c] as f32 / 255.0).collect());
    drop(guide_lr);
    let p: Vec<f32> = mask_lr.as_raw().iter().map(|&v| v as f32 / 255.0).collect();

    let mut temp1 = vec![0.0; area];
    let mut temp2 = vec![0.0; area];
    let mut box_filter = |src: &[f32]| {
        let mut mean = vec![0.0; area];
        box_filter_opt(src, &mut mean, &mut temp1, &mut temp2, w, h, r);
        mean
    };
    let product = |a: &[f32], b: &[f32]| -> Vec<f32> {
        a.par_iter().zip(b.par_iter()).map(|(x, y)| x * y).collect()
    };

    let mean_i = guide.each_ref().map(|c| box_filter(c));
    let mean_p = box_filter(&p);
    let mean_ip: [Vec<f32>; 3] = std::array::from_fn(|c| box_filter(&product(&guide[c], &p)));
    let mean_ii = [(0, 0), (0, 1), (0, 2), (1, 1), (1, 2), (2, 2)]
        .map(|(i, j)| box_filter(&product(&guide[i], &guide[j])));
    drop((guide, p));

    let coefficients: Vec<[f32; 4]> = (0..area)
        .into_par_iter()
        .map(|k| {
            let m = [mean_i[0][k], mean_i[1][k], mean_i[2][k]];
            let cov = [0, 1, 2].map(|c| mean_ip[c][k] - m[c] * mean_p[k]);
            let s00 = mean_ii[0][k] - m[0] * m[0] + eps;
            let s01 = mean_ii[1][k] - m[0] * m[1];
            let s02 = mean_ii[2][k] - m[0] * m[2];
            let s11 = mean_ii[3][k] - m[1] * m[1] + eps;
            let s12 = mean_ii[4][k] - m[1] * m[2];
            let s22 = mean_ii[5][k] - m[2] * m[2] + eps;
            let c00 = s11 * s22 - s12 * s12;
            let c01 = s02 * s12 - s01 * s22;
            let c02 = s01 * s12 - s02 * s11;
            let c11 = s00 * s22 - s02 * s02;
            let c12 = s01 * s02 - s00 * s12;
            let c22 = s00 * s11 - s01 * s01;
            let det = s00 * c00 + s01 * c01 + s02 * c02;
            let a0 = (c00 * cov[0] + c01 * cov[1] + c02 * cov[2]) / det;
            let a1 = (c01 * cov[0] + c11 * cov[1] + c12 * cov[2]) / det;
            let a2 = (c02 * cov[0] + c12 * cov[1] + c22 * cov[2]) / det;
            [a0, a1, a2, mean_p[k] - a0 * m[0] - a1 * m[1] - a2 * m[2]]
        })
        .collect();
    drop((mean_i, mean_p, mean_ip, mean_ii));

    let mean_coefficients: [Vec<f32>; 4] = std::array::from_fn(|i| {
        box_filter(&coefficients.iter().map(|c| c[i]).collect::<Vec<f32>>())
    });
    drop(coefficients);

    let (hr_w, hr_h) = (hr_w as usize, hr_h as usize);
    let x_samples: Vec<(usize, usize, f32)> = (0..hr_w)
        .map(|x| bilinear_sample(x, w as f32 / hr_w as f32, w))
        .collect();
    let mut final_mask_raw = vec![0u8; hr_w * hr_h];

    final_mask_raw
        .par_chunks_exact_mut(hr_w)
        .zip(guide_hr.as_raw().par_chunks_exact(hr_w * 3))
        .enumerate()
        .for_each(|(y, (out_row, guide_row))| {
            let (y0, y1, ty) = bilinear_sample(y, h as f32 / hr_h as f32, h);
            for (x, (out, pixel)) in out_row
                .iter_mut()
                .zip(guide_row.as_chunks::<3>().0)
                .enumerate()
            {
                let (x0, x1, tx) = x_samples[x];
                let sample = |values: &[f32]| {
                    let top = values[y0 * w + x0] * (1.0 - tx) + values[y0 * w + x1] * tx;
                    let bottom = values[y1 * w + x0] * (1.0 - tx) + values[y1 * w + x1] * tx;
                    top * (1.0 - ty) + bottom * ty
                };
                let q = (0..3)
                    .map(|c| sample(&mean_coefficients[c]) * pixel[c] as f32 / 255.0)
                    .sum::<f32>()
                    + sample(&mean_coefficients[3]);
                *out = (q.clamp(0.0, 1.0) * 255.0).round() as u8;
            }
        });

    GrayImage::from_raw(hr_w as u32, hr_h as u32, final_mask_raw).unwrap()
}

fn get_models_dir(app_handle: &tauri::AppHandle) -> Result<PathBuf> {
    let models_dir = app_handle.path().app_data_dir()?.join("models");
    if !models_dir.exists() {
        fs::create_dir_all(&models_dir)?;
    }
    Ok(models_dir)
}

/// HuggingFace is unreachable from some regions (notably mainland China) and
/// rate-limits unsigned clients, so every model download walks a list of
/// candidate endpoints (custom mirror -> official -> hf-mirror.com), retries
/// each endpoint, resumes partial downloads via HTTP Range, and streams the
/// body to disk instead of buffering whole models in memory.
const HF_DEFAULT_HOST: &str = "https://huggingface.co";
const HF_FALLBACK_HOST: &str = "https://hf-mirror.com";
const HF_ENDPOINT_ENV: &str = "RAPIDRAW_HF_ENDPOINT";

/// Transport failures on a single endpoint are often transient (proxy resets,
/// DNS hiccups), so every endpoint gets a few attempts with linear backoff
/// before the next endpoint in the chain is tried.
const MAX_ENDPOINT_ATTEMPTS: u32 = 3;

fn candidate_urls(url: &str) -> Vec<String> {
    let Some(rest) = url.strip_prefix(HF_DEFAULT_HOST) else {
        return vec![url.to_string()];
    };
    let mut urls = Vec::new();
    if let Ok(custom) = std::env::var(HF_ENDPOINT_ENV) {
        let custom = custom.trim().trim_end_matches('/');
        if !custom.is_empty() {
            urls.push(format!("{custom}{rest}"));
        }
    }
    urls.push(url.to_string());
    urls.push(format!("{HF_FALLBACK_HOST}{rest}"));
    urls
}

static HTTP_CLIENT: std::sync::LazyLock<reqwest::Client> = std::sync::LazyLock::new(|| {
    crate::http_tls::base_builder()
        .user_agent(concat!("RapidRAW/", env!("CARGO_PKG_VERSION")))
        // Short connect timeout so that an unreachable endpoint (e.g.
        // huggingface.co from mainland China) fails over to the mirror fast.
        .connect_timeout(Duration::from_secs(10))
        // Detect dead connections (NAT timeouts, sleeping devices) instead of
        // letting a stalled model download hang forever.
        .tcp_keepalive(Duration::from_secs(30))
        // Idle-read timeout: a connection that stops delivering chunks for a
        // minute is dead even if the TCP stack has not noticed yet. The
        // downloader's Range resume makes the next attempt continue from the
        // last byte instead of restarting the transfer.
        .read_timeout(Duration::from_secs(60))
        .build()
        .expect("failed to build HTTP client for model downloads")
});

/// reqwest's `Display` only names the request layer ("error sending request
/// …"); the actionable cause (DNS failure, TLS handshake rejection,
/// connection reset) sits further down the error chain. Flatten it into the
/// user-facing failure report so support can tell a blocked network apart
/// from a broken TLS setup.
fn describe_error_chain(error: &anyhow::Error) -> String {
    let mut text = error.to_string();
    for cause in error.chain().skip(1) {
        let cause = cause.to_string();
        if !text.contains(&cause) {
            text.push_str(" | ");
            text.push_str(&cause);
        }
    }
    text
}

async fn try_download_model(
    app_handle: &tauri::AppHandle,
    asset: &ModelAsset,
    tmp_path: &Path,
    url: &str,
) -> Result<()> {
    let start_offset = fs::metadata(tmp_path).map(|m| m.len()).unwrap_or(0);
    let mut request = HTTP_CLIENT.get(url);
    if start_offset > 0 {
        request = request.header("Range", format!("bytes={start_offset}-"));
    }
    let response = request.send().await?;
    if response.status().as_u16() == 416 {
        // Range not satisfiable — the partial file may already be complete.
        // The caller's sha256 check provides the final verdict.
        if start_offset > 0 {
            return Ok(());
        }
        anyhow::bail!("server rejected range request (HTTP 416)");
    }
    let mut response = response.error_for_status()?;
    let resume = response.status().as_u16() == 206;
    let total = response
        .content_length()
        .map(|len| len + if resume { start_offset } else { 0 })
        .unwrap_or(0);

    let mut file = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(!resume)
        .open(tmp_path)?;
    if resume {
        use std::io::Seek;
        file.seek(std::io::SeekFrom::Start(start_offset))?;
    }

    let mut written = if resume { start_offset } else { 0 };
    let mut last_progress = Instant::now();
    while let Some(chunk) = response.chunk().await? {
        file.write_all(&chunk)?;
        written += chunk.len() as u64;
        if total > 0 && last_progress.elapsed() >= Duration::from_millis(200) {
            last_progress = Instant::now();
            let _ = app_handle.emit(
                "ai-model-download-progress",
                serde_json::json!({ "name": asset.name, "current": written, "total": total }),
            );
        }
    }
    file.sync_all()?;
    if total > 0 && written != total {
        return Err(anyhow::anyhow!(
            "Incomplete download: received {written} of {total} bytes"
        ));
    }
    Ok(())
}

async fn download_model(
    app_handle: &tauri::AppHandle,
    asset: &ModelAsset,
    dest: &Path,
) -> Result<()> {
    let endpoints = candidate_urls(asset.url);
    let file_name = dest
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| anyhow::anyhow!("Invalid model asset path {}", dest.display()))?;
    let tmp_path = dest.with_file_name(format!(".{file_name}.download"));
    let parent = dest.parent().ok_or_else(|| {
        anyhow::anyhow!(
            "Cannot determine parent directory for downloaded model {}",
            dest.display()
        )
    })?;
    fs::create_dir_all(parent)?;

    let mut failures: Vec<String> = Vec::new();
    for url in &endpoints {
        for attempt in 1..=MAX_ENDPOINT_ATTEMPTS {
            match try_download_model(app_handle, asset, &tmp_path, url).await {
                Ok(()) => {
                    if dest.exists() {
                        fs::remove_file(dest)?;
                    }
                    fs::rename(&tmp_path, dest)?;
                    return Ok(());
                }
                Err(error) => {
                    failures.push(format!(
                        "{url} (attempt {attempt}): {}",
                        describe_error_chain(&error)
                    ));
                    tokio::time::sleep(Duration::from_millis(1000 * attempt as u64)).await;
                }
            }
        }
    }
    Err(anyhow::anyhow!(
        "Failed to download the {} model ({}).\n{}\n\
         Every endpoint was unreachable. You can:\n\
         - check your network connection or proxy settings,\n\
         - set the {} environment variable to a reachable mirror (e.g. {HF_FALLBACK_HOST}), or\n\
         - download the file manually and place it at {} (expected SHA256: {}).",
        asset.name,
        asset.filename,
        failures.join("\n"),
        HF_ENDPOINT_ENV,
        dest.display(),
        asset.sha256.unwrap_or("not verified"),
    ))
}

fn verify_sha256(path: &Path, expected_hash: &str) -> Result<bool> {
    if !path.exists() {
        return Ok(false);
    }
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0; 8192];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    let hash = hasher.finalize();
    let hex_hash = hex::encode(hash);
    Ok(hex_hash == expected_hash)
}

/// Downloads a model and verifies its SHA256.
///
/// The download is retried when the transferred bytes are corrupt: an unstable
/// connection or a caching proxy can serve a truncated body that still looks
/// like a successful transfer, and a single corrupt byte would otherwise
/// permanently break the model until the user intervenes. Transport failures
/// (every endpoint unreachable) are not retried here — `download_model` has
/// already walked all endpoints and attempts.
async fn download_and_verify_model(
    app_handle: &tauri::AppHandle,
    models_dir: &Path,
    asset: &ModelAsset,
) -> Result<()> {
    let dest_path = models_dir.join(asset.filename);
    let is_valid = match asset.sha256 {
        Some(expected_hash) => verify_sha256(&dest_path, expected_hash)?,
        None => dest_path.exists(),
    };

    if is_valid {
        return Ok(());
    }

    if dest_path.exists() {
        println!("Model {} has incorrect hash. Re-downloading.", asset.name);
        fs::remove_file(&dest_path)?;
    }
    let _ = app_handle.emit("ai-model-download-start", asset.name);
    let download_result = async {
        const MAX_DOWNLOAD_ATTEMPTS: usize = 3;
        let mut attempt = 0;
        loop {
            attempt += 1;
            download_model(app_handle, asset, &dest_path).await?;
            let Some(expected_hash) = asset.sha256 else {
                return Ok(());
            };
            if verify_sha256(&dest_path, expected_hash)? {
                return Ok(());
            }
            // Corrupt transfer (e.g. a caching proxy served a truncated body):
            // drop the file so the next attempt starts from scratch.
            println!(
                "Model {} download attempt {attempt} produced a corrupt file. Retrying.",
                asset.name
            );
            let _ = fs::remove_file(&dest_path);
            if attempt >= MAX_DOWNLOAD_ATTEMPTS {
                return Err(anyhow::anyhow!(
                    "Downloaded model {} failed SHA256 verification after {attempt} attempts \
                     (corrupt or truncated transfer). Please try again; if the problem persists, \
                     download the file manually and place it at {} (expected SHA256: {}).",
                    asset.name,
                    dest_path.display(),
                    expected_hash
                ));
            }
        }
    }
    .await;
    let _ = app_handle.emit(
        "ai-model-download-finish",
        serde_json::json!({
            "name": asset.name,
            "error": download_result.as_ref().err().map(|e| e.to_string()),
        }),
    );
    download_result
}

pub async fn get_or_init_ai_models(
    app_handle: &tauri::AppHandle,
    ai_state_mutex: &Mutex<Option<AiState>>,
    ai_init_lock: &TokioMutex<()>,
    model: AiMaskModel,
) -> Result<Arc<AiModels>> {
    let is_downloaded = |models: &AiModels| models.downloaded.lock().unwrap().contains(&model);

    if let Some(models) = cached_ai_state(ai_state_mutex, |state| state.models.clone())
        && is_downloaded(&models)
    {
        return Ok(models);
    }

    let _guard = ai_init_lock.lock().await;

    let models = match cached_ai_state(ai_state_mutex, |state| state.models.clone()) {
        Some(models) => models,
        None => {
            let _ = ort::init().with_name("AI").commit();
            crate::register_exit_handler();

            let models = Arc::new(AiModels {
                models_dir: get_models_dir(app_handle)?,
                use_gpu: gpu_acceleration_enabled(app_handle),
                downloaded: Mutex::new(HashSet::new()),
                sam_encoder: Mutex::new(None),
                sam_decoder: Mutex::new(None),
                birefnet: Mutex::new(None),
                esam3_image_encoder: Mutex::new(None),
                esam3_decoder: Mutex::new(None),
                esam3_text_encoder: Mutex::new(None),
                esam3_sky_prompt: Mutex::new(None),
                esam3_face_prompt: Mutex::new(None),
                clip_tokenizer: Mutex::new(None),
                face_landmarks: Mutex::new(None),
                face_segmenter: Mutex::new(None),
                depth_anything: Mutex::new(None),
                residency: Mutex::new(ResidencyTracker::new(ResidencyPolicy::for_platform(cfg!(
                    target_os = "android"
                )))),
                residency_epoch: Instant::now(),
            });
            ai_state_mutex
                .lock()
                .unwrap()
                .get_or_insert_with(AiState::default)
                .models = Some(models.clone());
            models
        }
    };

    if !is_downloaded(&models) {
        for asset in model.assets(models.gpu_inference()) {
            download_and_verify_model(app_handle, &models.models_dir, asset).await?;
        }
        models.downloaded.lock().unwrap().insert(model);
    }

    Ok(models)
}

pub async fn get_or_init_denoise_model(
    app_handle: &tauri::AppHandle,
    ai_state_mutex: &Mutex<Option<AiState>>,
    ai_init_lock: &TokioMutex<()>,
) -> Result<Arc<Mutex<Session>>> {
    if let Some(denoise_model) =
        cached_ai_state(ai_state_mutex, |state| state.denoise_model.clone())
    {
        touch_state_model(ai_state_mutex, DENOISE_FILENAME);
        return Ok(denoise_model);
    }

    let _guard = ai_init_lock.lock().await;

    if let Some(denoise_model) =
        cached_ai_state(ai_state_mutex, |state| state.denoise_model.clone())
    {
        touch_state_model(ai_state_mutex, DENOISE_FILENAME);
        return Ok(denoise_model);
    }

    enforce_state_residency(ai_state_mutex, DENOISE_FILENAME);
    let models_dir = get_models_dir(app_handle)?;
    download_and_verify_model(app_handle, &models_dir, &DENOISE_ASSET).await?;

    let _ = ort::init().with_name("AI-Denoise").commit();
    let model_path = models_dir.join(DENOISE_FILENAME);
    let session = build_session(
        &model_path,
        SessionKind::Persistent,
        gpu_acceleration_enabled(app_handle),
        Some(denoise_crop_as_slice),
    )?;
    let denoise_model = Arc::new(Mutex::new(session));

    crate::register_exit_handler();

    ai_state_mutex
        .lock()
        .unwrap()
        .get_or_insert_with(AiState::default)
        .denoise_model = Some(denoise_model.clone());

    touch_state_model(ai_state_mutex, DENOISE_FILENAME);
    Ok(denoise_model)
}

pub async fn get_or_init_clip_models(
    app_handle: &tauri::AppHandle,
    ai_state_mutex: &Mutex<Option<AiState>>,
    ai_init_lock: &TokioMutex<()>,
) -> Result<Arc<ClipModels>> {
    get_or_init_clip_models_impl(app_handle, ai_state_mutex, ai_init_lock, true).await
}

/// P0-1（release v2.1.16）：场景分类复用 CLIP 的免下载初始化。
/// 模型文件不在本地时返回 None，由调用方降级到 scene_classify 的统计
/// 启发式——场景识别不应静默触发数百 MB 下载（显式使用 CLIP 的文本
/// 蒙版 / AI 标签功能才走 `get_or_init_clip_models` 的下载路径）。
pub async fn get_or_init_clip_models_if_downloaded(
    app_handle: &tauri::AppHandle,
    ai_state_mutex: &Mutex<Option<AiState>>,
    ai_init_lock: &TokioMutex<()>,
) -> Option<Arc<ClipModels>> {
    get_or_init_clip_models_impl(app_handle, ai_state_mutex, ai_init_lock, false)
        .await
        .ok()
}

async fn get_or_init_clip_models_impl(
    app_handle: &tauri::AppHandle,
    ai_state_mutex: &Mutex<Option<AiState>>,
    ai_init_lock: &TokioMutex<()>,
    download_if_missing: bool,
) -> Result<Arc<ClipModels>> {
    if let Some(clip_models) = cached_ai_state(ai_state_mutex, |state| state.clip_models.clone()) {
        touch_state_model(ai_state_mutex, CLIP_MODEL_FILENAME);
        return Ok(clip_models);
    }

    if !download_if_missing {
        let models_dir = get_models_dir(app_handle)?;
        if !models_dir.join(CLIP_MODEL_FILENAME).is_file()
            || !models_dir.join(CLIP_TOKENIZER_FILENAME).is_file()
        {
            anyhow::bail!("CLIP model is not downloaded");
        }
    }

    let _guard = ai_init_lock.lock().await;

    if let Some(clip_models) = cached_ai_state(ai_state_mutex, |state| state.clip_models.clone()) {
        touch_state_model(ai_state_mutex, CLIP_MODEL_FILENAME);
        return Ok(clip_models);
    }

    enforce_state_residency(ai_state_mutex, CLIP_MODEL_FILENAME);
    let models_dir = get_models_dir(app_handle)?;

    if download_if_missing {
        download_and_verify_model(app_handle, &models_dir, &CLIP_MODEL_ASSET).await?;
        download_and_verify_model(app_handle, &models_dir, &CLIP_TOKENIZER_ASSET).await?;
    }
    let clip_tokenizer_path = models_dir.join(CLIP_TOKENIZER_FILENAME);

    let _ = ort::init().with_name("AI-Tagging").commit();
    let clip_model_path = models_dir.join(CLIP_MODEL_FILENAME);
    let model = Mutex::new(build_session(
        &clip_model_path,
        SessionKind::Persistent,
        gpu_allowed_on_platform() && gpu_acceleration_enabled(app_handle),
        None,
    )?);
    let tokenizer =
        Tokenizer::from_file(clip_tokenizer_path).map_err(|e| anyhow::anyhow!(e.to_string()))?;

    crate::register_exit_handler();

    let clip_models = Arc::new(ClipModels { model, tokenizer });

    ai_state_mutex
        .lock()
        .unwrap()
        .get_or_insert_with(AiState::default)
        .clip_models = Some(clip_models.clone());

    touch_state_model(ai_state_mutex, CLIP_MODEL_FILENAME);
    Ok(clip_models)
}

pub async fn get_or_init_lama_model(
    app_handle: &tauri::AppHandle,
    ai_state_mutex: &Mutex<Option<AiState>>,
    ai_init_lock: &TokioMutex<()>,
) -> Result<Arc<Mutex<Session>>> {
    if let Some(lama_model) = cached_ai_state(ai_state_mutex, |state| state.lama_model.clone()) {
        touch_state_model(ai_state_mutex, LAMA_FILENAME);
        return Ok(lama_model);
    }

    let _guard = ai_init_lock.lock().await;

    if let Some(lama_model) = cached_ai_state(ai_state_mutex, |state| state.lama_model.clone()) {
        touch_state_model(ai_state_mutex, LAMA_FILENAME);
        return Ok(lama_model);
    }

    enforce_state_residency(ai_state_mutex, LAMA_FILENAME);
    let models_dir = get_models_dir(app_handle)?;
    download_and_verify_model(app_handle, &models_dir, &LAMA_ASSET).await?;

    let _ = ort::init().with_name("AI-Inpainting").commit();
    let model_path = models_dir.join(LAMA_FILENAME);
    let session = build_session(&model_path, SessionKind::OneShot, false, None)?;
    let lama_model = Arc::new(Mutex::new(session));

    crate::register_exit_handler();

    ai_state_mutex
        .lock()
        .unwrap()
        .get_or_insert_with(AiState::default)
        .lama_model = Some(lama_model.clone());

    touch_state_model(ai_state_mutex, LAMA_FILENAME);
    Ok(lama_model)
}

pub async fn get_or_init_normal_model(
    app_handle: &tauri::AppHandle,
    ai_state_mutex: &Mutex<Option<AiState>>,
    ai_init_lock: &TokioMutex<()>,
) -> Result<Arc<Mutex<Session>>> {
    if let Some(normal_model) = cached_ai_state(ai_state_mutex, |state| state.normal_model.clone())
    {
        touch_state_model(ai_state_mutex, NORMAL_FILENAME);
        return Ok(normal_model);
    }

    let _guard = ai_init_lock.lock().await;

    if let Some(normal_model) = cached_ai_state(ai_state_mutex, |state| state.normal_model.clone())
    {
        touch_state_model(ai_state_mutex, NORMAL_FILENAME);
        return Ok(normal_model);
    }

    enforce_state_residency(ai_state_mutex, NORMAL_FILENAME);
    let models_dir = get_models_dir(app_handle)?;
    download_and_verify_model(app_handle, &models_dir, &NORMAL_ASSET).await?;

    let _ = ort::init().with_name("AI-Normal").commit();
    let model_path = models_dir.join(NORMAL_FILENAME);
    let session = build_session(
        &model_path,
        SessionKind::OneShot,
        gpu_allowed_on_platform() && gpu_acceleration_enabled(app_handle),
        None,
    )?;
    let normal_model = Arc::new(Mutex::new(session));

    crate::register_exit_handler();

    ai_state_mutex
        .lock()
        .unwrap()
        .get_or_insert_with(AiState::default)
        .normal_model = Some(normal_model.clone());

    touch_state_model(ai_state_mutex, NORMAL_FILENAME);
    Ok(normal_model)
}

#[derive(Clone, Copy)]
struct TileParams {
    cs: usize,
    margin: usize,
    overlap: usize,
}

const DENOISE_TILE: TileParams = TileParams {
    cs: 504,
    margin: 12,
    overlap: 64,
};

#[inline]
fn mirror_coord(c: i32, size: i32) -> i32 {
    if c < 0 {
        (-c).min(size - 1)
    } else if c >= size {
        (2 * size - 1 - c).max(0)
    } else {
        c
    }
}

fn extract_tile_mirror(img: &Rgb32FImage, x0: i32, y0: i32, cs: usize) -> Array4<f32> {
    let (w, h) = (img.width() as i32, img.height() as i32);
    let mut arr = Array4::zeros((1, 3, cs, cs));
    for dy in 0..cs as i32 {
        for dx in 0..cs as i32 {
            let sx = mirror_coord(x0 + dx, w);
            let sy = mirror_coord(y0 + dy, h);
            let px = img.get_pixel(sx as u32, sy as u32);
            arr[[0, 0, dy as usize, dx as usize]] = px[0];
            arr[[0, 1, dy as usize, dx as usize]] = px[1];
            arr[[0, 2, dy as usize, dx as usize]] = px[2];
        }
    }
    arr
}

fn tile_origins(len: usize, params: TileParams) -> Vec<i32> {
    let valid = params.cs - 2 * params.margin;
    let step = (valid - params.overlap).max(1);
    let mut origins = Vec::new();
    let mut start = 0;
    loop {
        origins.push(start as i32 - params.margin as i32);
        if start + valid >= len {
            break;
        }
        start += step;
    }
    origins
}

fn tile_blend_weights(params: TileParams) -> Vec<f32> {
    let valid = params.cs - 2 * params.margin;
    let ramp = |d: usize| ((d as f32 + 0.5) / params.overlap.max(1) as f32).min(1.0);
    (0..valid)
        .map(|i| {
            let t = ramp(i).min(ramp(valid - 1 - i));
            t * t * (3.0 - 2.0 * t)
        })
        .collect()
}

fn run_native_denoise(
    img: &Rgb32FImage,
    session: &Mutex<Session>,
    params: TileParams,
    on_progress: &dyn Fn(f32),
) -> Result<Rgb32FImage> {
    let (width, height) = (img.width() as usize, img.height() as usize);
    let valid = params.cs - 2 * params.margin;
    let weights = tile_blend_weights(params);
    let xs = tile_origins(width, params);
    let ys = tile_origins(height, params);
    let total = xs.len() * ys.len();

    let mut accumulator = vec![0.0f32; width * height * 3];
    let mut weight_sum = vec![0.0f32; width * height];

    for (i, (&y0, &x0)) in ys
        .iter()
        .flat_map(|y| xs.iter().map(move |x| (y, x)))
        .enumerate()
    {
        on_progress(i as f32 / total as f32);

        let crop = extract_tile_mirror(img, x0, y0, params.cs);
        let t_input = Tensor::from_array(crop.as_standard_layout().to_owned())?;

        let tile = {
            let mut sess = session.lock().unwrap();
            let outputs = gpu_inference(sess.run(ort::inputs![t_input]))?;
            outputs[0]
                .try_extract_array::<f32>()?
                .to_owned()
                .into_dimensionality::<ndarray::Ix4>()
                .map_err(|e| anyhow::anyhow!("Unexpected output shape: {}", e))?
        };

        for ty in 0..valid {
            let gy = y0 + (params.margin + ty) as i32;
            if gy < 0 || gy >= height as i32 {
                continue;
            }
            for tx in 0..valid {
                let gx = x0 + (params.margin + tx) as i32;
                if gx < 0 || gx >= width as i32 {
                    continue;
                }
                let w = weights[ty] * weights[tx];
                let idx = gy as usize * width + gx as usize;
                for c in 0..3 {
                    let v = tile[[0, c, params.margin + ty, params.margin + tx]].clamp(0.0, 1.0);
                    accumulator[idx * 3 + c] += v * w;
                }
                weight_sum[idx] += w;
            }
        }
    }

    let mut out = Rgb32FImage::new(width as u32, height as u32);
    out.par_chunks_exact_mut(3)
        .zip(accumulator.par_chunks_exact(3))
        .zip(weight_sum.par_iter())
        .for_each(|((px, acc), &w)| {
            let inv = if w > 0.0 { 1.0 / w } else { 0.0 };
            for c in 0..3 {
                px[c] = (acc[c] * inv).clamp(0.0, 1.0);
            }
        });
    Ok(out)
}

pub fn run_ai_denoise(
    rgb_img: &Rgb32FImage,
    session: &Mutex<Session>,
    on_progress: &dyn Fn(f32),
) -> Result<DynamicImage> {
    let out = run_native_denoise(rgb_img, session, DENOISE_TILE, on_progress)?;
    Ok(DynamicImage::ImageRgb32F(out))
}

const LAMA_PATCH_RADIUS: i32 = 3;
const LAMA_PATCH_MATCH_ITERS: u32 = 6;
/// P1-1：大面积诚实引导阈值——洞区占推理窗口（mask 外扩 1.5 倍 + 128px
/// 后的裁剪）比例超过该值即拒绝硬跑，由调用方向前端返回 guidance。
/// 阈值口径参照 ZhaJinWenQianCake 实测校准（单路障碍物 hole≈11% 可自动、
/// 多紧挨障碍物 ≈29% 需引导）；移动端屏幕小、涂抹面积天然受限，取 0.35
/// 兼顾桌面大图与移动端可用性。
const LAMA_MAX_HOLE_RATIO: f32 = 0.35;

/// P1-1：洞区占比超阈值时返回 Some(占比)，否则 None（纯函数，便于测试）。
fn lama_guidance_hole_ratio(hole_pixels: u64, crop_w: u32, crop_h: u32) -> Option<f32> {
    let ratio = hole_pixels as f32 / (crop_w as f32 * crop_h as f32);
    (ratio > LAMA_MAX_HOLE_RATIO).then_some(ratio)
}

/// P1-1：LaMa 输出量程自检——不同导出管线可能输出 0-255 / [0,1] / [-1,1]，
/// 把 0-255 输出当 [0,1] 裁剪会让 >1 的值全压成白色（参照仓库"填补结果
/// 96.7% 纯白"的病理），反之把 [0,1] 当 0-255 会整体压黑。从输出自身
/// min/max 判定量程，返回 (scale, offset)：归一化值 = v * scale + offset。
/// 判定口径：合法 [0,1] 输出不可能超过 1（fp16 误差留 5% 余量），故
/// max > 1.05 即 0-255 量程；min < -0.05 即 [-1,1] 量程。纯函数，便于测试。
fn lama_output_scale(out_min: f32, out_max: f32) -> (f32, f32) {
    if out_max > 1.05 {
        (1.0 / 255.0, 0.0) // 0-255 量程
    } else if out_min < -0.05 {
        (0.5, 0.5) // [-1,1] 量程
    } else {
        (1.0, 0.0) // [0,1] 量程（含全黑输出：与 0-255 全黑归一化结果一致）
    }
}

fn dilate_mask(mask: &[bool], w: usize, h: usize, r: usize) -> Vec<bool> {
    let mut horiz = vec![false; w * h];
    horiz.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        let src = &mask[y * w..(y + 1) * w];
        let mut prefix = vec![0u32; w + 1];
        for x in 0..w {
            prefix[x + 1] = prefix[x] + src[x] as u32;
        }
        for (x, out) in row.iter_mut().enumerate() {
            *out = prefix[(x + r + 1).min(w)] > prefix[x.saturating_sub(r)];
        }
    });
    let mut dilated = vec![false; w * h];
    dilated.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        let y0 = y.saturating_sub(r);
        let y1 = (y + r).min(h - 1);
        for (x, out) in row.iter_mut().enumerate() {
            *out = (y0..=y1).any(|yy| horiz[yy * w + x]);
        }
    });
    dilated
}

fn catmull_rom_sample(img: &[[f32; 3]], w: usize, h: usize, x: f32, y: f32) -> [f32; 3] {
    let weights = |t: f32| {
        let t2 = t * t;
        let t3 = t2 * t;
        [
            -0.5 * t3 + t2 - 0.5 * t,
            1.5 * t3 - 2.5 * t2 + 1.0,
            -1.5 * t3 + 2.0 * t2 + 0.5 * t,
            0.5 * t3 - 0.5 * t2,
        ]
    };
    let (fx, fy) = (x.floor(), y.floor());
    let wx = weights(x - fx);
    let wy = weights(y - fy);
    let mut acc = [0.0f32; 3];
    for (j, wyj) in wy.iter().enumerate() {
        let sy = (fy as i32 + j as i32 - 1).clamp(0, h as i32 - 1) as usize;
        for (i, wxi) in wx.iter().enumerate() {
            let sx = (fx as i32 + i as i32 - 1).clamp(0, w as i32 - 1) as usize;
            let p = img[sy * w + sx];
            let wgt = wyj * wxi;
            acc[0] += p[0] * wgt;
            acc[1] += p[1] * wgt;
            acc[2] += p[2] * wgt;
        }
    }
    acc
}

fn splitmix64(mut z: u64) -> u64 {
    z = z.wrapping_add(0x9E3779B97F4A7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
    z ^ (z >> 31)
}

fn patch_distance(
    target: &[[f32; 3]],
    source: &[[f32; 3]],
    w: usize,
    h: usize,
    t: (i32, i32),
    s: (i32, i32),
    limit: f32,
) -> f32 {
    let mut d = 0.0f32;
    for dy in -LAMA_PATCH_RADIUS..=LAMA_PATCH_RADIUS {
        let ty = (t.1 + dy).clamp(0, h as i32 - 1) as usize;
        let srow = (s.1 + dy) as usize * w;
        for dx in -LAMA_PATCH_RADIUS..=LAMA_PATCH_RADIUS {
            let tx = (t.0 + dx).clamp(0, w as i32 - 1) as usize;
            let a = target[ty * w + tx];
            let b = source[srow + (s.0 + dx) as usize];
            let (e0, e1, e2) = (a[0] - b[0], a[1] - b[1], a[2] - b[2]);
            d += e0 * e0 + e1 * e1 + e2 * e2;
        }
        if d >= limit {
            return d;
        }
    }
    d
}

fn lama_patch_match(
    target: &[[f32; 3]],
    source: &[[f32; 3]],
    w: usize,
    h: usize,
    is_target: &[bool],
    is_source: &[bool],
) -> Option<Vec<Option<(i32, i32)>>> {
    let sources: Vec<(i32, i32)> = (0..w * h)
        .filter(|&i| is_source[i])
        .map(|i| ((i % w) as i32, (i / w) as i32))
        .collect();
    let targets: Vec<usize> = (0..w * h).filter(|&i| is_target[i]).collect();
    if sources.is_empty() || targets.is_empty() {
        return None;
    }

    let valid = |p: (i32, i32)| {
        p.0 >= 0
            && p.1 >= 0
            && (p.0 as usize) < w
            && (p.1 as usize) < h
            && is_source[p.1 as usize * w + p.0 as usize]
    };
    let random_source = |seed: u64| sources[(seed % sources.len() as u64) as usize];

    let mut nnf = vec![(0i32, 0i32); w * h];
    let mut cost = vec![f32::MAX; w * h];
    let init: Vec<((i32, i32), f32)> = targets
        .par_iter()
        .map(|&i| {
            let t = ((i % w) as i32, (i / w) as i32);
            let s = random_source(splitmix64(i as u64));
            (s, patch_distance(target, source, w, h, t, s, f32::MAX))
        })
        .collect();
    for (&i, (s, c)) in targets.iter().zip(init) {
        nnf[i] = s;
        cost[i] = c;
    }

    for iter in 0..LAMA_PATCH_MATCH_ITERS {
        let jump = 1i32 << (LAMA_PATCH_MATCH_ITERS - 1 - iter).min(3);
        let updates: Vec<((i32, i32), f32)> = targets
            .par_iter()
            .map(|&i| {
                let t = ((i % w) as i32, (i / w) as i32);
                let mut best = nnf[i];
                let mut best_cost = cost[i];
                let consider = |c: (i32, i32), best: &mut (i32, i32), best_cost: &mut f32| {
                    if valid(c) && c != *best {
                        let d = patch_distance(target, source, w, h, t, c, *best_cost);
                        if d < *best_cost {
                            *best = c;
                            *best_cost = d;
                        }
                    }
                };

                for (dx, dy) in [(-jump, 0), (jump, 0), (0, -jump), (0, jump)] {
                    let (nx, ny) = (t.0 + dx, t.1 + dy);
                    if nx >= 0 && ny >= 0 && (nx as usize) < w && (ny as usize) < h {
                        let n = ny as usize * w + nx as usize;
                        if is_target[n] {
                            consider((nnf[n].0 - dx, nnf[n].1 - dy), &mut best, &mut best_cost);
                        }
                    }
                }

                let mut seed = splitmix64(i as u64 ^ ((iter as u64 + 1) << 40));
                let mut radius = w.max(h) as i32;
                while radius >= 1 {
                    seed = splitmix64(seed);
                    let span = (2 * radius + 1) as u64;
                    let c = (
                        best.0 + (seed % span) as i32 - radius,
                        best.1 + ((seed >> 32) % span) as i32 - radius,
                    );
                    consider(c, &mut best, &mut best_cost);
                    radius /= 2;
                }
                consider(random_source(splitmix64(seed)), &mut best, &mut best_cost);

                (best, best_cost)
            })
            .collect();
        for (&i, (s, c)) in targets.iter().zip(updates) {
            nnf[i] = s;
            cost[i] = c;
        }
    }

    Some((0..w * h).map(|i| is_target[i].then_some(nnf[i])).collect())
}

pub fn run_lama_inpainting(
    image: &DynamicImage,
    mask: &GrayImage,
    lama_session: &Mutex<Session>,
) -> Result<(RgbaImage, u32, u32)> {
    let (w, h) = image.dimensions();

    let (mut min_x, mut min_y) = (w, h);
    let (mut max_x, mut max_y) = (0u32, 0u32);
    let mut has_mask = false;
    let mut hole_pixels: u64 = 0;

    for (x, y, p) in mask.enumerate_pixels() {
        if p[0] > 0 {
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x);
            max_y = max_y.max(y);
            has_mask = true;
            hole_pixels += 1;
        }
    }

    if !has_mask {
        return Ok((image.to_rgba8(), 0, 0));
    }

    let mask_w = max_x - min_x + 1;
    let mask_h = max_y - min_y + 1;

    let pad_x = 128.max((mask_w as f32 * 1.5) as u32);
    let pad_y = 128.max((mask_h as f32 * 1.5) as u32);

    let x0 = min_x.saturating_sub(pad_x);
    let y0 = min_y.saturating_sub(pad_y);
    let x1 = (max_x + pad_x).min(w.saturating_sub(1));
    let y1 = (max_y + pad_y).min(h.saturating_sub(1));

    let crop_w = x1 - x0 + 1;
    let crop_h = y1 - y0 + 1;

    // P1-1：大面积诚实引导——洞区占比超阈值时不硬跑（LaMa 对超大洞区只能
    // 产出低质量臆测内容），返回带稳定前缀的错误，由调用方提示用户缩小
    // 涂抹范围。错误字符串形如 "lama_guidance:hole_ratio=0.42"。
    if let Some(hole_ratio) = lama_guidance_hole_ratio(hole_pixels, crop_w, crop_h) {
        return Err(anyhow::anyhow!("lama_guidance:hole_ratio={hole_ratio:.2}"));
    }

    let cropped_img = image.crop_imm(x0, y0, crop_w, crop_h).to_rgba8();
    let cropped_mask = imageops::crop_imm(mask, x0, y0, crop_w, crop_h).to_image();

    // P0-2：像素预算按机型分档（Android 旗舰 768 / 中端 576 / 低端 448，
    // 桌面恒 768）。LaMa 是全卷积 FFC 结构，动态尺寸无质量回退风险。
    let scale = (crate::ai_perf::lama_pixel_budget() / (crop_w as f32 * crop_h as f32))
        .sqrt()
        .min(1.0);
    let fw = ((crop_w as f32 * scale).round() as u32).max(1);
    let fh = ((crop_h as f32 * scale).round() as u32).max(1);
    let needs_downscale = fw != crop_w || fh != crop_h;

    let (inf_img, inf_mask) = if needs_downscale {
        (
            imageops::resize(&cropped_img, fw, fh, FilterType::Lanczos3),
            imageops::resize(&cropped_mask, fw, fh, FilterType::Triangle),
        )
    } else {
        (cropped_img.clone(), cropped_mask.clone())
    };

    let align = 32u32;
    let tensor_w = fw.div_ceil(align) * align;
    let tensor_h = fh.div_ceil(align) * align;

    let mut img_tensor = Array::<f32, _>::zeros((1, 3, tensor_h as usize, tensor_w as usize));
    let mut msk_tensor = Array::<f32, _>::zeros((1, 1, tensor_h as usize, tensor_w as usize));

    for y in 0..tensor_h {
        for x in 0..tensor_w {
            let p = inf_img.get_pixel(x.min(fw - 1), y.min(fh - 1));
            let m = inf_mask.get_pixel(x.min(fw - 1), y.min(fh - 1))[0];
            let (y, x) = (y as usize, x as usize);

            // P1-1：mask 契约——喂模型前洞内像素清零（image * (1 - mask)）。
            // 原样喂入洞内像素会让 LaMa 在洞区输出平坦的"复制"内容
            // （参照仓库实测病理）；细节还原用的 source 仍取原图像素，
            // 不受清零影响（is_source 本就排除洞邻域）。
            let keep = if m > 0 { 0.0 } else { 1.0 };
            img_tensor[[0, 0, y, x]] = p[0] as f32 / 255.0 * keep;
            img_tensor[[0, 1, y, x]] = p[1] as f32 / 255.0 * keep;
            img_tensor[[0, 2, y, x]] = p[2] as f32 / 255.0 * keep;
            msk_tensor[[0, 0, y, x]] = if m > 0 { 1.0 } else { 0.0 };
        }
    }

    let t_img = Tensor::from_array(img_tensor.into_dyn().as_standard_layout().into_owned())?;
    let t_msk = Tensor::from_array(msk_tensor.into_dyn().as_standard_layout().into_owned())?;

    let output_tensor = {
        let mut session = lama_session.lock().unwrap();
        let outputs = session.run(ort::inputs!["image" => t_img, "mask" => t_msk])?;
        outputs[0].try_extract_array::<f32>()?.to_owned()
    };

    // P1-1：输出量程自检——从输出自身 min/max 判定 0-255 / [0,1] / [-1,1]
    // 再归一化，避免把 0-255 输出当 [0,1] 裁剪成纯白（或反之整体压黑）。
    let (out_min, out_max) = output_tensor
        .iter()
        .fold((f32::INFINITY, f32::NEG_INFINITY), |(lo, hi), &v| {
            (lo.min(v), hi.max(v))
        });
    let (out_scale, out_offset) = lama_output_scale(out_min, out_max);

    let (iw, ih) = (fw as usize, fh as usize);
    let target: Vec<[f32; 3]> = (0..iw * ih)
        .map(|i| {
            let (x, y) = (i % iw, i / iw);
            [0, 1, 2].map(|c| {
                (output_tensor[[0, c, y, x]] * out_scale + out_offset).clamp(0.0, 1.0)
            })
        })
        .collect();
    let source: Vec<[f32; 3]> = inf_img
        .pixels()
        .map(|p| {
            [
                p[0] as f32 / 255.0,
                p[1] as f32 / 255.0,
                p[2] as f32 / 255.0,
            ]
        })
        .collect();

    let nnf = if needs_downscale {
        let hole: Vec<bool> = inf_mask.pixels().map(|p| p[0] > 0).collect();
        let is_target = dilate_mask(&hole, iw, ih, 1);
        let blocked = dilate_mask(&hole, iw, ih, LAMA_PATCH_RADIUS as usize + 2);
        let r = LAMA_PATCH_RADIUS;
        let is_source: Vec<bool> = (0..iw * ih)
            .map(|i| {
                let (x, y) = ((i % iw) as i32, (i / iw) as i32);
                !blocked[i] && x >= r && y >= r && x < iw as i32 - r && y < ih as i32 - r
            })
            .collect();
        lama_patch_match(&target, &source, iw, ih, &is_target, &is_source)
    } else {
        None
    };

    let sx = fw as f32 / crop_w as f32;
    let sy = fh as f32 / crop_h as f32;
    let mut final_crop = cropped_img.clone();

    final_crop
        .par_chunks_mut(crop_w as usize * 4)
        .enumerate()
        .for_each(|(y, row)| {
            for x in 0..crop_w as usize {
                let m = cropped_mask.get_pixel(x as u32, y as u32)[0];
                if m == 0 {
                    continue;
                }
                let u = (x as f32 + 0.5) * sx - 0.5;
                let v = (y as f32 + 0.5) * sy - 0.5;
                let mut value = catmull_rom_sample(&target, iw, ih, u, v);

                if let Some(nnf) = &nnf {
                    let (u0, v0) = (u.floor(), v.floor());
                    let (fu, fv) = (u - u0, v - v0);
                    let mut groups = [((0i32, 0i32), 0.0f32, [0.0f32; 3]); 4];
                    let mut group_count = 0;
                    for (cu, cv, wgt) in [
                        (u0, v0, (1.0 - fu) * (1.0 - fv)),
                        (u0 + 1.0, v0, fu * (1.0 - fv)),
                        (u0, v0 + 1.0, (1.0 - fu) * fv),
                        (u0 + 1.0, v0 + 1.0, fu * fv),
                    ] {
                        let cu = (cu as i32).clamp(0, iw as i32 - 1);
                        let cv = (cv as i32).clamp(0, ih as i32 - 1);
                        let Some((su, sv)) = nnf[cv as usize * iw + cu as usize] else {
                            continue;
                        };
                        let qx = x as i32 + ((su - cu) as f32 / sx).round() as i32;
                        let qy = y as i32 + ((sv - cv) as f32 / sy).round() as i32;
                        if qx < 0 || qy < 0 || qx >= crop_w as i32 || qy >= crop_h as i32 {
                            continue;
                        }
                        if cropped_mask.get_pixel(qx as u32, qy as u32)[0] > 0 {
                            continue;
                        }
                        let o = cropped_img.get_pixel(qx as u32, qy as u32);
                        let low = catmull_rom_sample(
                            &source,
                            iw,
                            ih,
                            (qx as f32 + 0.5) * sx - 0.5,
                            (qy as f32 + 0.5) * sy - 0.5,
                        );
                        let detail = [0, 1, 2].map(|c| o[c] as f32 / 255.0 - low[c]);
                        let shift = (qx - x as i32, qy - y as i32);
                        match groups[..group_count].iter_mut().find(|g| g.0 == shift) {
                            Some(g) => g.1 += wgt,
                            None => {
                                groups[group_count] = (shift, wgt, detail);
                                group_count += 1;
                            }
                        }
                    }
                    let norm = groups[..group_count]
                        .iter()
                        .map(|g| g.1 * g.1)
                        .sum::<f32>()
                        .sqrt();
                    if norm > 0.0 {
                        for (_, wgt, detail) in &groups[..group_count] {
                            for c in 0..3 {
                                value[c] += wgt * detail[c] / norm;
                            }
                        }
                    }
                }

                let alpha = m as f32 / 255.0;
                let px = &mut row[x * 4..x * 4 + 3];
                for c in 0..3 {
                    px[c] = (value[c].clamp(0.0, 1.0) * 255.0 * alpha
                        + px[c] as f32 * (1.0 - alpha))
                        .round() as u8;
                }
            }
        });

    Ok((final_crop, x0, y0))
}

pub fn generate_image_embeddings(
    image: &DynamicImage,
    encoder: &Mutex<Session>,
) -> Result<ImageEmbeddings> {
    let (orig_width, orig_height) = image.dimensions();

    let long_side = orig_width.max(orig_height) as f32;
    let scale = SAM_INPUT_SIZE as f32 / long_side;
    let new_width = (orig_width as f32 * scale).round() as u32;
    let new_height = (orig_height as f32 * scale).round() as u32;

    let resized_image = image.resize(new_width, new_height, FilterType::Triangle);
    let rgb_image = resized_image.into_rgb8();
    let (actual_width, actual_height) = rgb_image.dimensions();
    let raw_pixels = rgb_image.as_raw();

    let mut input_tensor: Array<u8, _> =
        Array::zeros((1, 3, SAM_INPUT_SIZE as usize, SAM_INPUT_SIZE as usize));

    let w_usize = actual_width as usize;
    for y in 0..(actual_height as usize) {
        for x in 0..w_usize {
            let idx = (y * w_usize + x) * 3;
            input_tensor[[0, 0, y, x]] = raw_pixels[idx];
            input_tensor[[0, 1, y, x]] = raw_pixels[idx + 1];
            input_tensor[[0, 2, y, x]] = raw_pixels[idx + 2];
        }
    }

    let input_tensor_dyn = input_tensor.into_dyn();
    let input_values = input_tensor_dyn.as_standard_layout();
    let input_tensor_ort = Tensor::from_array(input_values.into_owned())?;
    let mut session = encoder.lock().unwrap();
    let outputs = session.run(ort::inputs![input_tensor_ort])?;

    let embeddings = outputs[0].try_extract_array::<f32>()?.to_owned();

    Ok(ImageEmbeddings {
        path_hash: "".to_string(),
        embeddings: embeddings.into_dyn(),
        original_size: (orig_width, orig_height),
    })
}

pub fn run_sam_decoder(
    decoder: &Mutex<Session>,
    embeddings: &ImageEmbeddings,
    start_point: (f64, f64),
    end_point: (f64, f64),
    original_image: Option<&DynamicImage>,
) -> Result<GrayImage> {
    let (orig_width, orig_height) = embeddings.original_size;
    let long_side = orig_width.max(orig_height) as f64;
    let scale = SAM_INPUT_SIZE as f64 / long_side;

    let iters = 2;

    let is_point =
        (start_point.0 - end_point.0).abs() < 1e-6 && (start_point.1 - end_point.1).abs() < 1e-6;
    let mut point_coords = Vec::new();
    let mut point_labels = Vec::new();

    if is_point {
        point_coords.push((
            (start_point.0 * scale) as f32,
            (start_point.1 * scale) as f32,
        ));
        point_labels.push(1.0f32);
    } else {
        let x1 = (start_point.0.min(end_point.0) * scale) as f32;
        let y1 = (start_point.1.min(end_point.1) * scale) as f32;
        let x2 = (start_point.0.max(end_point.0) * scale) as f32;
        let y2 = (start_point.1.max(end_point.1) * scale) as f32;
        point_coords.push((x1, y1));
        point_coords.push((x2, y2));
        point_labels.push(2.0f32);
        point_labels.push(3.0f32);
    }

    let mut mask_input = Array::zeros((1, 1, 256, 256)).into_dyn();
    let mut has_mask_input = 0.0f32;

    let orig_im_size =
        Array::from_shape_vec((2,), vec![orig_height as f32, orig_width as f32])?.into_dyn();

    let mut final_mask_data: Vec<u8> = Vec::new();
    let mut final_w = 0;
    let mut final_h = 0;

    for i in 0..iters {
        let pc_len = point_coords.len();
        let pl_len = point_labels.len();

        let coords_flat: Vec<f32> = point_coords.iter().flat_map(|&(x, y)| vec![x, y]).collect();
        let coords_array = Array::from_shape_vec((1, pc_len, 2), coords_flat)?.into_dyn();
        let labels_array = Array::from_shape_vec((1, pl_len), point_labels.clone())?.into_dyn();

        let t_embeddings = Tensor::from_array(
            embeddings
                .embeddings
                .clone()
                .as_standard_layout()
                .into_owned(),
        )?;
        let t_point_coords = Tensor::from_array(coords_array.as_standard_layout().into_owned())?;
        let t_point_labels = Tensor::from_array(labels_array.as_standard_layout().into_owned())?;
        let t_mask_input =
            Tensor::from_array(mask_input.clone().as_standard_layout().into_owned())?;
        let t_has_mask = Tensor::from_array(
            Array::from_elem((1,), has_mask_input)
                .into_dyn()
                .as_standard_layout()
                .into_owned(),
        )?;
        let t_orig_im_size =
            Tensor::from_array(orig_im_size.clone().as_standard_layout().into_owned())?;

        let mask_tensor = {
            let mut session = decoder.lock().unwrap();
            let outputs = session.run(ort::inputs![
                t_embeddings,
                t_point_coords,
                t_point_labels,
                t_mask_input,
                t_has_mask,
                t_orig_im_size
            ])?;
            outputs[0].try_extract_array::<f32>()?.to_owned()
        };

        let mask_dims = mask_tensor.shape();
        let h = mask_dims[2];
        let w = mask_dims[3];
        let area = h * w;

        let mask_slice = mask_tensor.as_slice().unwrap();
        let first_mask_slice = &mask_slice[0..area];

        if i == iters - 1 {
            final_mask_data = first_mask_slice
                .iter()
                .map(|&val| if val > 0.0 { 255 } else { 0 })
                .collect();
            final_w = w;
            final_h = h;
            break;
        }

        let mut binary_mask = vec![false; area];
        let mut mask_area = 0.0;
        let mut min_x = w;
        let mut min_y = h;
        let mut max_x = 0;
        let mut max_y = 0;

        for (idx, &val) in first_mask_slice.iter().enumerate() {
            if val > 0.0 {
                binary_mask[idx] = true;
                let x = idx % w;
                let y = idx / w;
                min_x = min_x.min(x);
                max_x = max_x.max(x);
                min_y = min_y.min(y);
                max_y = max_y.max(y);
                mask_area += 1.0;
            }
        }

        if mask_area == 0.0 || min_x > max_x {
            final_mask_data = first_mask_slice
                .iter()
                .map(|&val| if val > 0.0 { 255 } else { 0 })
                .collect();
            final_w = w;
            final_h = h;
            break;
        }

        let dt_in = edt_2d(&binary_mask, w, h);
        let mut max_in = 0.0;
        let mut pos_idx = 0;
        for (idx, &v) in dt_in.iter().enumerate() {
            if v > max_in {
                max_in = v;
                pos_idx = idx;
            }
        }
        let pos_y = pos_idx / w;
        let pos_x = pos_idx % w;

        let mut rev_mask = vec![false; area];
        for (idx, is_true) in binary_mask.iter().enumerate() {
            rev_mask[idx] = !is_true;
        }
        let mut dt_out = edt_2d(&rev_mask, w, h);

        for y in 0..h {
            for x in 0..w {
                if x < min_x || x > max_x || y < min_y || y > max_y {
                    dt_out[y * w + x] = 0.0;
                }
            }
        }

        let mut max_out = 0.0;
        let mut neg_idx = 0;
        for (idx, &v) in dt_out.iter().enumerate() {
            if v > max_out {
                max_out = v;
                neg_idx = idx;
            }
        }
        let neg_y = neg_idx / w;
        let neg_x = neg_idx % w;

        point_coords.clear();
        point_labels.clear();

        point_coords.push(((pos_x as f64 * scale) as f32, (pos_y as f64 * scale) as f32));
        point_labels.push(1.0);
        point_coords.push(((neg_x as f64 * scale) as f32, (neg_y as f64 * scale) as f32));
        point_labels.push(0.0);
        point_coords.push(((min_x as f64 * scale) as f32, (min_y as f64 * scale) as f32));
        point_labels.push(2.0);
        point_coords.push(((max_x as f64 * scale) as f32, (max_y as f64 * scale) as f32));
        point_labels.push(3.0);

        let mut gaus_dt = vec![0.0f32; area];
        let variance = (mask_area / 4.0_f32).max(1.0_f32);
        for (idx, &is_true) in binary_mask.iter().enumerate() {
            if is_true {
                let diff = dt_in[idx] - max_in;
                gaus_dt[idx] = (-(diff * diff) / variance).exp();
            }
        }

        let mask_f32_vec: Vec<f32> = first_mask_slice
            .iter()
            .map(|&v| if v > 0.0 { 15.0 } else { -15.0 })
            .collect();

        let img_mask_f32 =
            ImageBuffer::<Luma<f32>, Vec<f32>>::from_raw(w as u32, h as u32, mask_f32_vec).unwrap();
        let img_gaus_f32 =
            ImageBuffer::<Luma<f32>, Vec<f32>>::from_raw(w as u32, h as u32, gaus_dt).unwrap();

        let resized_mask = imageops::resize(&img_mask_f32, 256, 256, FilterType::Triangle);
        let resized_gaus = imageops::resize(&img_gaus_f32, 256, 256, FilterType::Triangle);

        let rm_raw = resized_mask.as_raw();
        let rg_raw = resized_gaus.as_raw();
        let mut mask_input_flat = vec![0.0f32; 256 * 256];

        for i in 0..(256 * 256) {
            let m_val = rm_raw[i];
            let mut g_val = rg_raw[i];
            if g_val <= 0.0 {
                g_val = 1.0;
            }
            mask_input_flat[i] = m_val * g_val;
        }

        mask_input = Array::from_shape_vec((1, 1, 256, 256), mask_input_flat)
            .unwrap()
            .into_dyn();
        has_mask_input = 1.0;
    }

    let gray_mask = GrayImage::from_raw(final_w as u32, final_h as u32, final_mask_data)
        .ok_or_else(|| anyhow::anyhow!("Failed to create mask image from raw data"))?;

    if let Some(img) = original_image {
        let (orig_width, orig_height) = img.dimensions();
        let guide_hr = img.to_luma8();

        let long_edge = orig_width.max(orig_height) as f32;
        let radius = (long_edge * 0.0075).clamp(8.0, 24.0);

        let resized_coarse_mask =
            image::imageops::resize(&gray_mask, orig_width, orig_height, FilterType::Triangle);

        let feathered_coarse_mask = image::imageops::blur(&resized_coarse_mask, radius / 3.0);

        let mut refined_mask =
            fast_guided_filter(&guide_hr, &feathered_coarse_mask, radius as usize, 0.01);

        for p in refined_mask.pixels_mut() {
            let v = p[0] as f32 / 255.0;
            p[0] = (((v - 0.03) / 0.94).clamp(0.0, 1.0) * 255.0).round() as u8;
        }

        Ok(refined_mask)
    } else {
        let feathered_mask = image::imageops::blur(&gray_mask, 2.0);
        let (orig_width, orig_height) = embeddings.original_size;
        let final_mask = image::imageops::resize(
            &feathered_mask,
            orig_width,
            orig_height,
            FilterType::Triangle,
        );

        Ok(final_mask)
    }
}

fn sigmoid(value: f32) -> f32 {
    1.0 / (1.0 + (-value).exp())
}

pub fn run_esam3_image_encoder(
    image: &DynamicImage,
    encoder_session: &Mutex<Session>,
) -> Result<Esam3Features> {
    let size = ESAM3_INPUT_SIZE as usize;
    let padding = ESAM3_INPUT_PADDING as i64;
    let inner = ESAM3_INPUT_SIZE - 2 * ESAM3_INPUT_PADDING;
    let resized_rgb = image
        .resize_exact(inner, inner, FilterType::Triangle)
        .into_rgb8();

    let reflect = |i: usize| -> u32 {
        let (i, n) = (i as i64 - padding, inner as i64);
        let i = if i < 0 { -i } else { i };
        (if i >= n { 2 * n - 2 - i } else { i }) as u32
    };
    let mut input_tensor = Array4::<f32>::zeros((1, 3, size, size));
    for y in 0..size {
        let src_y = reflect(y);
        for x in 0..size {
            let pixel = resized_rgb.get_pixel(reflect(x), src_y);
            for c in 0..3 {
                input_tensor[[0, c, y, x]] = pixel[c] as f32 / 127.5 - 1.0;
            }
        }
    }

    let mut session = encoder_session.lock().unwrap();
    let outputs =
        gpu_inference(session.run(ort::inputs!["image" => Tensor::from_array(input_tensor)?]))?;
    let extract = |name: &str| -> Result<Array<f32, IxDyn>> {
        Ok(outputs[name].try_extract_array::<f32>()?.to_owned())
    };

    Ok(Esam3Features {
        path_hash: String::new(),
        fpn: [extract("fpn_0")?, extract("fpn_1")?, extract("fpn_2")?],
        pos: extract("pos_2")?,
    })
}

fn run_esam3_queries<T>(
    decoder_session: &Mutex<Session>,
    features: &Esam3Features,
    prompt: &Esam3Prompt,
    read: impl FnOnce(Vec<f32>, ArrayViewD<f32>, ArrayViewD<f32>) -> T,
) -> Result<T> {
    let exemplar_boxes = Array::<f32, _>::zeros((ESAM3_EXEMPLAR_SLOTS, 1, 4));
    let exemplar_labels = Array::<i64, _>::zeros((ESAM3_EXEMPLAR_SLOTS, 1));
    let exemplar_mask = Array::<f32, _>::ones((1, ESAM3_EXEMPLAR_SLOTS));

    let mut session = decoder_session.lock().unwrap();
    let outputs = gpu_inference(session.run(ort::inputs![
        "fpn_0" => TensorRef::from_array_view(&features.fpn[0])?,
        "fpn_1" => TensorRef::from_array_view(&features.fpn[1])?,
        "fpn_2" => TensorRef::from_array_view(&features.fpn[2])?,
        "pos_2" => TensorRef::from_array_view(&features.pos)?,
        "language_features" => TensorRef::from_array_view(&prompt.features)?,
        "language_padding" => TensorRef::from_array_view(&prompt.padding)?,
        "exemplar_boxes" => Tensor::from_array(exemplar_boxes)?,
        "exemplar_labels" => Tensor::from_array(exemplar_labels)?,
        "exemplar_mask" => Tensor::from_array(exemplar_mask)?,
    ]))?;

    let presence = outputs["presence_logit"]
        .try_extract_array::<f32>()?
        .iter()
        .next()
        .map_or(0.0, |&v| sigmoid(v));
    let scores = outputs["pred_logits"]
        .try_extract_array::<f32>()?
        .iter()
        .map(|&logit| sigmoid(logit) * presence)
        .collect();
    Ok(read(
        scores,
        outputs["pred_boxes"].try_extract_array::<f32>()?,
        outputs["pred_masks"].try_extract_array::<f32>()?,
    ))
}

pub fn run_esam3_boxes(
    decoder_session: &Mutex<Session>,
    features: &Esam3Features,
    prompt: &Esam3Prompt,
    score_threshold: f32,
) -> Result<Vec<(f32, [f32; 4])>> {
    let mut detections =
        run_esam3_queries(decoder_session, features, prompt, |scores, boxes, _| {
            scores
                .iter()
                .enumerate()
                .filter(|&(_, &score)| score > score_threshold)
                .map(|(query, &score)| {
                    let size = ESAM3_INPUT_SIZE as f32;
                    let padding = ESAM3_INPUT_PADDING as f32;
                    let inner = size - 2.0 * padding;
                    let [cx, cy, w, h]: [f32; 4] = std::array::from_fn(|i| {
                        let v = boxes[[0, query, i]] * size;
                        if i < 2 {
                            (v - padding) / inner
                        } else {
                            v / inner
                        }
                    });
                    (
                        score,
                        [cx - w / 2.0, cy - h / 2.0, cx + w / 2.0, cy + h / 2.0],
                    )
                })
                .collect::<Vec<_>>()
        })?;
    detections.sort_by(|a, b| b.0.total_cmp(&a.0));
    Ok(detections)
}

pub fn run_esam3_decoder(
    decoder_session: &Mutex<Session>,
    features: &Esam3Features,
    prompt: &Esam3Prompt,
    image: &DynamicImage,
    score_threshold: f32,
    refine_eps: f32,
) -> Result<Option<GrayImage>> {
    let (coarse_mask, mask_w, mask_h) =
        run_esam3_queries(decoder_session, features, prompt, |scores, _, masks| {
            let (mask_h, mask_w) = (masks.shape()[2], masks.shape()[3]);
            let mut coarse_mask: Option<Vec<f32>> = None;
            for (query, &score) in scores.iter().enumerate() {
                if score <= score_threshold {
                    continue;
                }
                let combined = coarse_mask.get_or_insert_with(|| vec![0.0; mask_h * mask_w]);
                let query_mask = masks.slice(s![0, query, .., ..]);
                for (out, &value) in combined.iter_mut().zip(query_mask.iter()) {
                    *out = out.max(sigmoid(value));
                }
            }
            (coarse_mask, mask_w, mask_h)
        })?;

    let Some(coarse_mask) = coarse_mask else {
        return Ok(None);
    };

    // P1-2：分位数自适应归一化（参照仓库 semantic.py 百分位归一化）——
    // 固定 [0.3, 0.7] 重映射在弱置信对象上把整片掩膜压成近透明、在强
    // 置信对象上把 <0.3 的软边缘削平。用掩膜自身 p99 作满值刻度自适应；
    // p99 低于 ESAM3_MASK_LOW 说明没有真实信号，维持固定阈值行为不变。
    // 注意：query 分数判定（上面的 score_threshold）始终用 RAW 置信度，
    // 不走本归一化——归一化会把背景弱响应一起拉高（参照仓库 overlap
    // 判定病理：占比 0.86 的人物被误算成路人）。
    let adaptive_hi = percentile_mask_remap(&coarse_mask);
    let coarse_mask = GrayImage::from_raw(
        mask_w as u32,
        mask_h as u32,
        coarse_mask
            .iter()
            .map(|&v| {
                let v = match adaptive_hi {
                    Some(hi) => (v / hi).clamp(0.0, 1.0),
                    None => {
                        ((v - ESAM3_MASK_LOW) / (ESAM3_MASK_HIGH - ESAM3_MASK_LOW)).clamp(0.0, 1.0)
                    }
                };
                (v * 255.0).round() as u8
            })
            .collect(),
    )
    .ok_or_else(|| anyhow::anyhow!("Failed to create mask from EfficientSAM3 output"))?;

    let input_mask = imageops::resize(
        &coarse_mask,
        ESAM3_INPUT_SIZE,
        ESAM3_INPUT_SIZE,
        FilterType::Triangle,
    );
    let inner = ESAM3_INPUT_SIZE - 2 * ESAM3_INPUT_PADDING;
    let image_mask = imageops::crop_imm(
        &input_mask,
        ESAM3_INPUT_PADDING,
        ESAM3_INPUT_PADDING,
        inner,
        inner,
    )
    .to_image();

    let (orig_width, orig_height) = image.dimensions();
    let scale = (ESAM3_REFINE_SIZE as f32 / orig_width.max(orig_height) as f32).min(1.0);
    let refine_w = ((orig_width as f32 * scale).round() as u32).max(1);
    let refine_h = ((orig_height as f32 * scale).round() as u32).max(1);
    let refine_mask = imageops::resize(&image_mask, refine_w, refine_h, FilterType::Triangle);

    Ok(Some(fast_color_guided_filter(
        &image.to_rgb8(),
        &refine_mask,
        ESAM3_REFINE_RADIUS,
        refine_eps,
    )))
}

pub fn run_esam3_zoomed_decoder(
    encoder_session: &Mutex<Session>,
    decoder_session: &Mutex<Session>,
    features: &Esam3Features,
    prompt: &Esam3Prompt,
    image: &DynamicImage,
    score_threshold: f32,
    refine_eps: f32,
) -> Result<Option<GrayImage>> {
    let Some(mut mask) = run_esam3_decoder(
        decoder_session,
        features,
        prompt,
        image,
        score_threshold,
        refine_eps,
    )?
    else {
        return Ok(None);
    };

    let (width, height) = image.dimensions();
    let grid_size = ZOOM_MIN_SIDE as u32;
    let grid = imageops::resize(&mask, grid_size, grid_size, FilterType::Triangle);
    if let Some((x, y, crop_width, crop_height)) = zoom_region(&grid, width, height) {
        let crop = image.crop_imm(x, y, crop_width, crop_height);
        let crop_features = run_esam3_image_encoder(&crop, encoder_session)?;
        if let Some(detail) = run_esam3_decoder(
            decoder_session,
            &crop_features,
            prompt,
            &crop,
            score_threshold,
            refine_eps,
        )? && mask_iou(&mask, &detail, x, y) >= ESAM3_ZOOM_MIN_IOU
        {
            blend_feathered(&mut mask, &detail, x, y);
        }
    }

    Ok(Some(mask))
}

pub fn run_birefnet_model(
    image: &DynamicImage,
    birefnet_session: &Mutex<Session>,
) -> Result<GrayImage> {
    let (width, height) = image.dimensions();
    let mut session = birefnet_session.lock().unwrap();
    let coarse = run_birefnet_pass(image, &mut session)?;
    let mut mask = imageops::resize(&coarse, width, height, FilterType::Triangle);

    if let Some((x, y, crop_width, crop_height)) = zoom_region(&coarse, width, height) {
        let detail =
            run_birefnet_pass(&image.crop_imm(x, y, crop_width, crop_height), &mut session)?;
        let detail = imageops::resize(&detail, crop_width, crop_height, FilterType::Triangle);
        if mask_iou(&mask, &detail, x, y) >= BIREFNET_ZOOM_MIN_IOU {
            blend_feathered(&mut mask, &detail, x, y);
        }
    }

    // P1-2：guided filter 贴边后处理（参照仓库 matting.py：alpha 与亮度
    // 引导滤波融合）。BiRefNet 概率图本身质量好，但 1024² 上采样回原图的
    // 边缘仍会切过发丝/肩部；用亮度引导滤波把掩膜边界贴到图像边缘。
    // 与 ESAM3 管线同几何：掩膜降到 ≤1024 长边过滤、系数双线性上采样回
    // 原尺寸，半径/eps 与 ESAM3 精修一致，成本量级相同。
    let scale = (ESAM3_REFINE_SIZE as f32 / width.max(height) as f32).min(1.0);
    let refine_w = ((width as f32 * scale).round() as u32).max(1);
    let refine_h = ((height as f32 * scale).round() as u32).max(1);
    let mask_lr = imageops::resize(&mask, refine_w, refine_h, FilterType::Triangle);
    let mask = fast_color_guided_filter(
        &image.to_rgb8(),
        &mask_lr,
        ESAM3_REFINE_RADIUS,
        BIREFNET_REFINE_EPS,
    );

    Ok(mask)
}

fn mask_iou(mask: &GrayImage, detail: &GrayImage, x0: u32, y0: u32) -> f32 {
    let (mut intersection, mut union) = (0u64, 0u64);
    for (u, v, refined) in detail.enumerate_pixels() {
        let base = mask.get_pixel(x0 + u, y0 + v)[0] >= 128;
        let refined = refined[0] >= 128;
        intersection += (base && refined) as u64;
        union += (base || refined) as u64;
    }
    if union == 0 {
        0.0
    } else {
        intersection as f32 / union as f32
    }
}

fn blend_feathered(mask: &mut GrayImage, detail: &GrayImage, x0: u32, y0: u32) {
    let (width, height) = mask.dimensions();
    let (crop_width, crop_height) = detail.dimensions();
    let feather = (crop_width.min(crop_height) as f32 * ZOOM_FEATHER).max(1.0);
    let ramp = |start: u32, length: u32, extent: u32| -> Vec<f32> {
        (0..length)
            .map(|i| {
                let head = if start == 0 { f32::MAX } else { i as f32 + 0.5 };
                let tail = if start + length == extent {
                    f32::MAX
                } else {
                    (length - i) as f32 - 0.5
                };
                (head.min(tail) / feather).min(1.0)
            })
            .collect()
    };
    let weights_x = ramp(x0, crop_width, width);
    let weights_y = ramp(y0, crop_height, height);

    for (v, weight_y) in weights_y.iter().enumerate() {
        for (u, weight_x) in weights_x.iter().enumerate() {
            let weight = weight_x.min(*weight_y);
            let base = mask.get_pixel(x0 + u as u32, y0 + v as u32)[0] as f32;
            let refined = detail.get_pixel(u as u32, v as u32)[0] as f32;
            mask.put_pixel(
                x0 + u as u32,
                y0 + v as u32,
                Luma([(base + (refined - base) * weight).round() as u8]),
            );
        }
    }
}

fn zoom_region(coarse: &GrayImage, width: u32, height: u32) -> Option<(u32, u32, u32, u32)> {
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (u32::MAX, u32::MAX, 0, 0);
    for (x, y, pixel) in coarse.enumerate_pixels() {
        if pixel[0] >= 128 {
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x + 1);
            max_y = max_y.max(y + 1);
        }
    }
    if min_x == u32::MAX {
        return None;
    }

    let scale_x = width as f32 / coarse.width() as f32;
    let scale_y = height as f32 / coarse.height() as f32;
    let long_side = width.max(height) as f32;
    let subject_side = ((max_x - min_x) as f32 * scale_x).max((max_y - min_y) as f32 * scale_y);
    let side = (subject_side * (1.0 + 2.0 * ZOOM_MARGIN))
        .max(ZOOM_MIN_SIDE)
        .min(long_side);
    if side > ZOOM_MAX_FRACTION * long_side {
        return None;
    }

    let place = |min: u32, max: u32, scale: f32, extent: u32| {
        let center = (min + max) as f32 * 0.5 * scale;
        let length = side.min(extent as f32);
        let start = (center - length * 0.5).clamp(0.0, extent as f32 - length);
        (start as u32, (length as u32).min(extent - start as u32))
    };
    let (x, crop_width) = place(min_x, max_x, scale_x, width);
    let (y, crop_height) = place(min_y, max_y, scale_y, height);
    Some((x, y, crop_width, crop_height))
}

fn run_birefnet_pass(image: &DynamicImage, session: &mut Session) -> Result<GrayImage> {
    let size = BIREFNET_INPUT_SIZE as usize;
    let resized_rgb = image
        .resize_exact(
            BIREFNET_INPUT_SIZE,
            BIREFNET_INPUT_SIZE,
            FilterType::Triangle,
        )
        .into_rgb8();

    let mean = [0.485, 0.456, 0.406];
    let std = [0.229, 0.224, 0.225];

    let mut input_tensor = Array4::<f32>::zeros((1, 3, size, size));
    for (x, y, pixel) in resized_rgb.enumerate_pixels() {
        for c in 0..3 {
            input_tensor[[0, c, y as usize, x as usize]] =
                (pixel[c] as f32 / 255.0 - mean[c]) / std[c];
        }
    }

    let outputs = gpu_inference(session.run(ort::inputs![Tensor::from_array(input_tensor)?]))?;
    let mask_data: Vec<u8> = outputs[0]
        .try_extract_array::<f32>()?
        .iter()
        .map(|&v| (sigmoid(v) * 255.0).round() as u8)
        .collect();

    GrayImage::from_raw(BIREFNET_INPUT_SIZE, BIREFNET_INPUT_SIZE, mask_data)
        .ok_or_else(|| anyhow::anyhow!("Failed to create mask from BiRefNet output"))
}

pub fn run_depth_anything_model(
    image: &DynamicImage,
    depth_session: &Mutex<Session>,
) -> Result<GrayImage> {
    let resized_image = image.resize(DEPTH_INPUT_SIZE, DEPTH_INPUT_SIZE, FilterType::Triangle);
    let (resized_w, resized_h) = resized_image.dimensions();
    let resized_rgb = resized_image.into_rgb8();
    let raw_pixels = resized_rgb.as_raw();

    let paste_x = ((DEPTH_INPUT_SIZE - resized_w) / 2) as usize;
    let paste_y = ((DEPTH_INPUT_SIZE - resized_h) / 2) as usize;

    let mut input_tensor: Array<f32, _> =
        Array::zeros((1, 3, DEPTH_INPUT_SIZE as usize, DEPTH_INPUT_SIZE as usize));

    let mean = [0.485, 0.456, 0.406];
    let std = [0.229, 0.224, 0.225];

    let rw = resized_w as usize;
    let rh = resized_h as usize;

    for y in 0..rh {
        for x in 0..rw {
            let idx = (y * rw + x) * 3;
            let dest_y = y + paste_y;
            let dest_x = x + paste_x;

            input_tensor[[0, 0, dest_y, dest_x]] =
                (raw_pixels[idx] as f32 / 255.0 - mean[0]) / std[0];
            input_tensor[[0, 1, dest_y, dest_x]] =
                (raw_pixels[idx + 1] as f32 / 255.0 - mean[1]) / std[1];
            input_tensor[[0, 2, dest_y, dest_x]] =
                (raw_pixels[idx + 2] as f32 / 255.0 - mean[2]) / std[2];
        }
    }

    let input_tensor_dyn = input_tensor.into_dyn();
    let t_input = Tensor::from_array(input_tensor_dyn.as_standard_layout().into_owned())?;

    let mut session = depth_session.lock().unwrap();
    let outputs = gpu_inference(session.run(ort::inputs![t_input]))?;
    let output_tensor = outputs[0].try_extract_array::<f32>()?.to_owned();
    let out_slice = output_tensor.as_slice().unwrap();

    let usize_size = DEPTH_INPUT_SIZE as usize;

    let mut min_val = f32::MAX;
    let mut max_val = f32::MIN;
    for y in 0..rh {
        let src_y = y + paste_y;
        for x in 0..rw {
            let src_x = x + paste_x;
            let val = out_slice[src_y * usize_size + src_x];
            min_val = min_val.min(val);
            max_val = max_val.max(val);
        }
    }

    let range = max_val - min_val;
    let scale = if range > 1e-6 { 255.0 / range } else { 0.0 };

    let mut cropped_depth_data = Vec::with_capacity(rw * rh);

    for y in 0..rh {
        let src_y = y + paste_y;
        for x in 0..rw {
            let src_x = x + paste_x;
            let val = out_slice[src_y * usize_size + src_x];
            let pixel = if range > 1e-6 {
                ((val - min_val) * scale) as u8
            } else {
                0
            };
            cropped_depth_data.push(pixel);
        }
    }

    let depth_map = GrayImage::from_raw(resized_w, resized_h, cropped_depth_data)
        .ok_or_else(|| anyhow::anyhow!("Failed to create mask from Depth output"))?;

    Ok(depth_map)
}

fn build_normal_depth(points: &[f32], mask: &[f32]) -> Vec<u8> {
    let valid = |point: &[f32; 3], m: f32| {
        m >= 0.5 && point.iter().all(|v| v.is_finite()) && point[2] > 0.0
    };

    let mut depths: Vec<f32> = points
        .as_chunks::<3>()
        .0
        .iter()
        .zip(mask)
        .filter(|(point, m)| valid(point, **m))
        .map(|(point, _)| point[2])
        .collect();

    if depths.len() < 16 {
        return vec![255; mask.len()];
    }

    depths.sort_unstable_by(|a, b| a.total_cmp(b));
    let percentile = |p: f32| depths[((depths.len() - 1) as f32 * p) as usize];
    let near = percentile(0.005);
    let range = (percentile(0.995) - near).max(1e-6);

    points
        .as_chunks::<3>()
        .0
        .iter()
        .zip(mask)
        .map(|(point, m)| {
            if valid(point, *m) {
                (((point[2] - near) / range).clamp(0.0, 1.0) * 255.0).round() as u8
            } else {
                255
            }
        })
        .collect()
}

pub fn run_normal_model(
    image: &DynamicImage,
    normal_session: &Mutex<Session>,
) -> Result<RgbaImage> {
    let resized_image = if image.width().max(image.height()) > NORMAL_MAX_SIZE {
        image.resize(NORMAL_MAX_SIZE, NORMAL_MAX_SIZE, FilterType::Triangle)
    } else {
        image.clone()
    };
    let (resized_w, resized_h) = resized_image.dimensions();
    let resized_rgb = resized_image.into_rgb8();
    let raw_pixels = resized_rgb.as_raw();

    let rw = resized_w as usize;
    let rh = resized_h as usize;

    let mut input_tensor: Array<f32, _> = Array::zeros((1, 3, rh, rw));
    for y in 0..rh {
        for x in 0..rw {
            let idx = (y * rw + x) * 3;
            input_tensor[[0, 0, y, x]] = raw_pixels[idx] as f32 / 255.0;
            input_tensor[[0, 1, y, x]] = raw_pixels[idx + 1] as f32 / 255.0;
            input_tensor[[0, 2, y, x]] = raw_pixels[idx + 2] as f32 / 255.0;
        }
    }

    let t_image = Tensor::from_array(input_tensor.into_dyn())?;
    let t_num_tokens = Tensor::from_array(ndarray::arr0(NORMAL_NUM_TOKENS))?;

    let mut session = normal_session.lock().unwrap();
    let outputs = gpu_inference(session.run(ort::inputs![
        "image" => t_image,
        "num_tokens" => t_num_tokens,
    ]))?;

    let normal_tensor = outputs["normal"].try_extract_array::<f32>()?;
    let mask_tensor = outputs["mask"].try_extract_array::<f32>()?;
    let points_tensor = outputs["points"].try_extract_array::<f32>()?;

    if normal_tensor.shape() != [1, rh, rw, 3]
        || mask_tensor.shape() != [1, rh, rw]
        || points_tensor.shape() != [1, rh, rw, 3]
    {
        return Err(anyhow::anyhow!(
            "Unexpected normal model output shape: {:?} / {:?} / {:?}",
            normal_tensor.shape(),
            mask_tensor.shape(),
            points_tensor.shape()
        ));
    }

    let normals = normal_tensor.as_standard_layout();
    let normals = normals.as_slice().unwrap();
    let mask = mask_tensor.as_standard_layout();
    let mask = mask.as_slice().unwrap();
    let points = points_tensor.as_standard_layout();
    let depth = build_normal_depth(points.as_slice().unwrap(), mask);

    let pack = |v: f32| ((v * 0.5 + 0.5).clamp(0.0, 1.0) * 255.0).round() as u8;

    let mut normal_data = Vec::with_capacity(rw * rh * 4);
    for (n, d) in normals.as_chunks::<3>().0.iter().zip(depth) {
        let (nx, ny, nz) = (n[0], -n[1], -n[2]);
        let len = (nx * nx + ny * ny + nz * nz).sqrt();
        if len.is_finite() && len > 1e-6 {
            normal_data.extend_from_slice(&[pack(nx / len), pack(ny / len), pack(nz / len)]);
        } else {
            normal_data.extend_from_slice(&[128, 128, 255]);
        }
        normal_data.push(d);
    }

    RgbaImage::from_raw(resized_w, resized_h, normal_data)
        .ok_or_else(|| anyhow::anyhow!("Failed to create normal map from model output"))
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiSubjectMaskParameters {
    pub start_x: f64,
    pub start_y: f64,
    pub end_x: f64,
    pub end_y: f64,
    #[serde(default)]
    pub mask_data_base64: Option<String>,
    #[serde(default)]
    pub rotation: Option<f32>,
    #[serde(default)]
    pub flip_horizontal: Option<bool>,
    #[serde(default)]
    pub flip_vertical: Option<bool>,
    #[serde(default)]
    pub orientation_steps: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub box_space_width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub box_space_height: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_source: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiSkyMaskParameters {
    #[serde(default)]
    pub mask_data_base64: Option<String>,
    #[serde(default)]
    pub rotation: Option<f32>,
    #[serde(default)]
    pub flip_horizontal: Option<bool>,
    #[serde(default)]
    pub flip_vertical: Option<bool>,
    #[serde(default)]
    pub orientation_steps: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_source: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiTextMaskParameters {
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub mask_data_base64: Option<String>,
    #[serde(default)]
    pub rotation: Option<f32>,
    #[serde(default)]
    pub flip_horizontal: Option<bool>,
    #[serde(default)]
    pub flip_vertical: Option<bool>,
    #[serde(default)]
    pub orientation_steps: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_source: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiFaceMaskParameters {
    #[serde(default)]
    pub parts: Vec<String>,
    #[serde(default)]
    pub mask_data_base64: Option<String>,
    #[serde(default)]
    pub rotation: Option<f32>,
    #[serde(default)]
    pub flip_horizontal: Option<bool>,
    #[serde(default)]
    pub flip_vertical: Option<bool>,
    #[serde(default)]
    pub orientation_steps: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_source: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiForegroundMaskParameters {
    #[serde(default)]
    pub mask_data_base64: Option<String>,
    #[serde(default)]
    pub rotation: Option<f32>,
    #[serde(default)]
    pub flip_horizontal: Option<bool>,
    #[serde(default)]
    pub flip_vertical: Option<bool>,
    #[serde(default)]
    pub orientation_steps: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_source: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiDepthMaskParameters {
    #[serde(default)]
    pub min_depth: f32,
    #[serde(default)]
    pub max_depth: f32,
    #[serde(default)]
    pub min_fade: f32,
    #[serde(default)]
    pub max_fade: f32,
    #[serde(default)]
    pub feather: f32,
    #[serde(default)]
    pub mask_data_base64: Option<String>,
    #[serde(default)]
    pub rotation: Option<f32>,
    #[serde(default)]
    pub flip_horizontal: Option<bool>,
    #[serde(default)]
    pub flip_vertical: Option<bool>,
    #[serde(default)]
    pub orientation_steps: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_source: Option<String>,
}

/// Every downloadable AI model, in the order the settings UI lists them.
/// `sha256` is empty for assets that are not hash-pinned; the manifest reports
/// that as an integrity issue instead of quietly accepting an unverified file.
pub fn model_inventory(models_dir: &Path) -> ModelManifest {
    const MODEL_CARD: &str = "https://huggingface.co/CyberTimon/RapidRAW-Models";
    let spec =
        |role: &str, display_name: &str, filename: &str, url: &str, sha256: &str| ModelSpec {
            role: role.to_string(),
            display_name: display_name.to_string(),
            filename: filename.to_string(),
            download_url: url.to_string(),
            sha256: sha256.to_string(),
            license: "See model card".to_string(),
            license_url: Some(MODEL_CARD.to_string()),
            installed_bytes: None,
        };

    let specs = vec![
        spec(
            "sam_encoder",
            "SAM Encoder",
            ENCODER_FILENAME,
            ENCODER_URL,
            ENCODER_SHA256,
        ),
        spec(
            "sam_decoder",
            "SAM Decoder",
            DECODER_FILENAME,
            DECODER_URL,
            DECODER_SHA256,
        ),
        spec(
            "efficientsam_encoder",
            "EfficientSAM Encoder",
            ESAM3_IMAGE_ENCODER_FILENAME,
            ESAM3_IMAGE_ENCODER_URL,
            ESAM3_IMAGE_ENCODER_SHA256,
        ),
        spec(
            "efficientsam_decoder",
            "EfficientSAM Decoder",
            ESAM3_DECODER_FILENAME,
            ESAM3_DECODER_URL,
            ESAM3_DECODER_SHA256,
        ),
        spec(
            "efficientsam_text_encoder",
            "EfficientSAM Text Encoder",
            ESAM3_TEXT_ENCODER_FILENAME,
            ESAM3_TEXT_ENCODER_URL,
            ESAM3_TEXT_ENCODER_SHA256,
        ),
        spec(
            "efficientsam_sky_prompt",
            "Sky Prompt",
            ESAM3_SKY_PROMPT_FILENAME,
            ESAM3_SKY_PROMPT_URL,
            ESAM3_SKY_PROMPT_SHA256,
        ),
        spec(
            "efficientsam_face_prompt",
            "Face Prompt",
            ESAM3_FACE_PROMPT_FILENAME,
            ESAM3_FACE_PROMPT_URL,
            ESAM3_FACE_PROMPT_SHA256,
        ),
        spec(
            "foreground_fp16",
            "Foreground Model (GPU)",
            BIREFNET_FP16_FILENAME,
            BIREFNET_FP16_URL,
            BIREFNET_FP16_SHA256,
        ),
        spec(
            "foreground_fp32",
            "Foreground Model (CPU)",
            BIREFNET_FP32_FILENAME,
            BIREFNET_FP32_URL,
            BIREFNET_FP32_SHA256,
        ),
        spec(
            "face_landmarks",
            "Face Landmarks",
            FACE_LANDMARKS_FILENAME,
            FACE_LANDMARKS_URL,
            FACE_LANDMARKS_SHA256,
        ),
        spec(
            "face_segmenter",
            "Face Segmentation",
            FACE_SEGMENTER_FILENAME,
            FACE_SEGMENTER_URL,
            FACE_SEGMENTER_SHA256,
        ),
        spec(
            "depth",
            "Depth Model",
            DEPTH_FILENAME,
            DEPTH_URL,
            DEPTH_SHA256,
        ),
        spec(
            "normal",
            "Relight Normal Model",
            NORMAL_FILENAME,
            NORMAL_URL,
            NORMAL_SHA256,
        ),
        spec(
            "clip",
            "CLIP",
            CLIP_MODEL_FILENAME,
            CLIP_MODEL_URL,
            CLIP_MODEL_SHA256,
        ),
        spec(
            "clip_tokenizer",
            "CLIP Tokenizer",
            CLIP_TOKENIZER_FILENAME,
            CLIP_TOKENIZER_URL,
            "",
        ),
        spec(
            "denoise",
            "AI Denoise",
            DENOISE_FILENAME,
            DENOISE_URL,
            DENOISE_SHA256,
        ),
        spec(
            "lama",
            "Generative Fill",
            LAMA_FILENAME,
            LAMA_URL,
            LAMA_SHA256,
        ),
    ];

    model_registry::build_manifest(model_registry::with_installed_sizes(specs, models_dir))
}

#[tauri::command]
pub async fn get_ai_model_inventory(app_handle: tauri::AppHandle) -> Result<ModelManifest, String> {
    let models_dir = get_models_dir(&app_handle).map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || model_inventory(&models_dir))
        .await
        .map_err(|error| error.to_string())
}

/// P0-3（release v2.1.16）：AI 诊断报告。用户报障「AI 慢 / 不可用」时
/// 一次性给出可归因的事实：平台与每个模型实际生效的 EP（防静默回退）、
/// 模型落点与校验状态；`deep` 模式追加逐模型会话构建耗时与 CLIP 224px
/// 实测推理耗时（把「一切正常但超慢」的假阳性变成可验证事实），并附
/// 日志尾部的 AI 相关记录。所有失败如实呈现，不猜测、不静默。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AiModelDiagnostic {
    pub role: String,
    pub display_name: String,
    pub filename: String,
    pub installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_bytes: Option<u64>,
    pub path: String,
    /// 该模型实际生效的 EP："CPU" | "DirectML" | "CoreML" | "n/a"（非 ONNX 资产）。
    pub effective_ep: String,
    /// "ok" | "mismatch" | "unverified" | "not_installed"。
    pub sha256_status: String,
    /// deep 模式：ONNX 会话构建耗时（毫秒；移动端首推延迟的主要构成）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_build_ms: Option<u128>,
    /// deep 模式：CLIP 224px 端到端实测推理耗时（毫秒）；仅 CLIP 填报。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub probe_inference_ms: Option<u128>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AiDiagnostics {
    pub app_version: String,
    pub platform: String,
    /// 平台可用的 GPU EP：DirectML / CoreML / none（Android 与 Linux 为 none，纯 CPU）。
    pub platform_gpu_ep: String,
    /// 用户设置里的 GPU 加速开关。
    pub gpu_enabled_setting: bool,
    /// 运行时 GPU 状态：idle / active / failed（failed 后自动回落 CPU）。
    pub gpu_runtime_status: String,
    pub deep: bool,
    pub models_dir: String,
    /// P0-2：机型档位（Android：flagship/mid/low；桌面：desktop 不分级）。
    pub device_tier: String,
    /// P0-2：进程可见核数。
    pub cpu_cores: usize,
    /// P0-2：总内存 MB（0 = 探测不到）。
    pub total_ram_mb: u64,
    /// P0-2：intra-op 线程上限（"1"/"2"/"default"=ORT 默认吃满物理核）。
    pub intra_op_threads: String,
    pub models: Vec<AiModelDiagnostic>,
    pub manifest_healthy: bool,
    pub issues: Vec<String>,
    /// 日志尾部与 AI 相关的 WARN/ERROR 记录（最多 5 条，最新在前）。
    pub recent_ai_logs: Vec<String>,
}

fn platform_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "android") {
        "android"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unknown"
    }
}

fn platform_gpu_ep() -> &'static str {
    if cfg!(target_os = "windows") {
        "DirectML"
    } else if cfg!(target_os = "macos") {
        "CoreML"
    } else {
        "none"
    }
}

fn gpu_status_label() -> &'static str {
    match GPU_STATUS.load(Ordering::Acquire) {
        GPU_ACTIVE => "active",
        GPU_FAILED => "failed",
        _ => "idle",
    }
}

/// 每个模型实际生效的 EP——按各自初始化调用点的 GPU 门槛如实推导
/// （与 `build_session` 调用点逐条对齐，不做统一假设）：
/// - 固定 CPU：SAM 编解码器 / 人脸关键点 / 人脸分割 / LaMa / ESAM3
///   文本塔 / foreground_fp32（调用点固定传 false，或本身就是 CPU 回退档）；
/// - 平台门控（`gpu_allowed_on_platform`）：foreground_fp16 / ESAM3
///   图像塔与解码器 / 法线 / CLIP——macOS 上即使开关打开也走 CPU；
/// - 仅看开关与运行时状态：降噪 / 深度（调用点不查平台门控）。
fn model_effective_ep(role: &str, gpu_on: bool, platform_ep: &str, gpu_failed: bool) -> String {
    if role == "efficientsam_prompt" || role == "clip_tokenizer" {
        return "n/a".to_string();
    }
    if gpu_failed || platform_ep == "none" || !gpu_on {
        return "CPU".to_string();
    }
    match role {
        "sam_encoder" | "sam_decoder" | "face_landmarks" | "face_segmenter" | "lama"
        | "efficientsam_text_encoder" | "foreground_fp32" => "CPU".to_string(),
        "foreground_fp16" | "efficientsam_encoder" | "efficientsam_decoder" | "normal"
        | "clip" => {
            if gpu_allowed_on_platform() {
                platform_ep.to_string()
            } else {
                "CPU".to_string()
            }
        }
        _ => platform_ep.to_string(), // denoise / depth
    }
}

/// 读取日志尾部与 AI 相关的 WARN/ERROR 记录（最多 5 条，最新在前）。
/// 日志不可读时返回空——诊断不因此失败。
fn recent_ai_logs(app_handle: &tauri::AppHandle) -> Vec<String> {
    const AI_LOG_KEYWORDS: [&str; 10] = [
        "model", "session", "clip", "denoise", "lama", "onnx", "gpu", "inference", "efficientsam",
        "birefnet",
    ];
    let Ok(log_dir) = app_handle.path().app_log_dir() else {
        return Vec::new();
    };
    let Ok(content) = fs::read_to_string(log_dir.join("app.log")) else {
        return Vec::new();
    };
    content
        .lines()
        .filter(|line| {
            (line.contains("[WARN]") || line.contains("[ERROR]"))
                && AI_LOG_KEYWORDS
                    .iter()
                    .any(|kw| line.to_lowercase().contains(kw))
        })
        .rev()
        .take(5)
        .map(|line| line.to_string())
        .collect()
}

/// P0-3：AI 诊断命令。`deep=true` 时逐模型验证 SHA256、构建会话计时，
/// 并对 CLIP 跑一次 224px 端到端实测（中低端机上可能需要数十秒）。
#[tauri::command]
pub async fn diagnose_ai(
    app_handle: tauri::AppHandle,
    deep: Option<bool>,
) -> Result<AiDiagnostics, String> {
    let deep = deep.unwrap_or(false);
    let models_dir = get_models_dir(&app_handle).map_err(|e| e.to_string())?;
    let manifest = model_inventory(&models_dir);
    let manifest_healthy = manifest.is_healthy();
    let manifest_issues = manifest.issues.clone();
    let gpu_on = gpu_acceleration_enabled(&app_handle);
    let platform_ep = platform_gpu_ep();
    let gpu_failed = GPU_STATUS.load(Ordering::Acquire) == GPU_FAILED;
    let models_dir_display = models_dir.to_string_lossy().to_string();

    let models = tauri::async_runtime::spawn_blocking(move || {
        if deep {
            let _ = ort::init().with_name("AI-Diagnose").commit();
        }
        manifest
            .models
            .iter()
            .map(|spec| {
                let path = models_dir.join(&spec.filename);
                let mut diag = AiModelDiagnostic {
                    role: spec.role.clone(),
                    display_name: spec.display_name.clone(),
                    filename: spec.filename.clone(),
                    installed: spec.installed_bytes.is_some(),
                    installed_bytes: spec.installed_bytes,
                    path: path.to_string_lossy().to_string(),
                    effective_ep: model_effective_ep(&spec.role, gpu_on, platform_ep, gpu_failed),
                    sha256_status: "not_installed".to_string(),
                    session_build_ms: None,
                    probe_inference_ms: None,
                    note: None,
                };
                if !diag.installed {
                    return diag;
                }
                if spec.sha256.is_empty() {
                    diag.sha256_status = "unverified".to_string();
                    diag.note = Some("manifest does not pin a hash".to_string());
                } else if deep {
                    match model_registry::verify_file(&path, &spec.sha256) {
                        Ok(()) => diag.sha256_status = "ok".to_string(),
                        Err(e) => {
                            diag.sha256_status = "mismatch".to_string();
                            diag.note = Some(format!("sha256 mismatch: {e}"));
                        }
                    }
                } else {
                    diag.sha256_status = "unverified".to_string();
                }

                if deep && spec.filename.ends_with(".onnx") {
                    // 会话构建计时：移动端首次使用延迟的主要构成（图解析 +
                    // EP 初始化）。构建后立即 drop，避免诊断本身推高内存。
                    let started = Instant::now();
                    match build_session(
                        &path,
                        SessionKind::OneShot,
                        gpu_allowed_on_platform() && gpu_on,
                        None,
                    ) {
                        Ok(session) => {
                            diag.session_build_ms = Some(started.elapsed().as_millis());
                            if spec.filename == CLIP_MODEL_FILENAME {
                                // CLIP 输入尺寸固定（224px）且是场景分类与
                                // 文本蒙版的共用路径：跑一次真实前向作为端到端
                                // 探针（顺带验证 tokenizer 可用）。
                                match Tokenizer::from_file(
                                    models_dir.join(CLIP_TOKENIZER_FILENAME),
                                ) {
                                    Ok(tokenizer) => {
                                        let clip = ClipModels {
                                            model: Mutex::new(session),
                                            tokenizer,
                                        };
                                        let probe_img = DynamicImage::ImageRgb8(
                                            RgbImage::from_fn(64, 64, |x, y| {
                                                image::Rgb([x as u8, y as u8, 160])
                                            }),
                                        );
                                        let probe_started = Instant::now();
                                        match crate::tagging::generate_tags_with_clip(
                                            &probe_img,
                                            &clip.model,
                                            &clip.tokenizer,
                                            Some(vec!["a photo".to_string()]),
                                            1,
                                        ) {
                                            Ok(_) => {
                                                diag.probe_inference_ms =
                                                    Some(probe_started.elapsed().as_millis());
                                            }
                                            Err(e) => {
                                                diag.note =
                                                    Some(format!("CLIP probe failed: {e}"));
                                            }
                                        }
                                    }
                                    Err(e) => {
                                        diag.note = Some(format!("CLIP tokenizer load failed: {e}"));
                                    }
                                }
                            }
                        }
                        Err(e) => {
                            diag.note = Some(format!("session build failed: {e}"));
                        }
                    }
                }
                diag
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())?;

    Ok(AiDiagnostics {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        platform: platform_name().to_string(),
        platform_gpu_ep: platform_ep.to_string(),
        gpu_enabled_setting: gpu_on,
        gpu_runtime_status: gpu_status_label().to_string(),
        deep,
        models_dir: models_dir_display,
        device_tier: crate::ai_perf::tier_label().to_string(),
        cpu_cores: crate::ai_perf::detected_cores(),
        total_ram_mb: crate::ai_perf::detected_ram_mb(),
        intra_op_threads: crate::ai_perf::intra_op_threads_label(),
        models,
        manifest_healthy,
        issues: manifest_issues,
        recent_ai_logs: recent_ai_logs(&app_handle),
    })
}

#[tauri::command]
pub async fn delete_ai_model(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    role: String,
) -> Result<(), String> {
    let models_dir = get_models_dir(&app_handle).map_err(|error| error.to_string())?;
    let spec = model_inventory(&models_dir)
        .models
        .into_iter()
        .find(|model| model.role == role)
        .ok_or_else(|| format!("Unknown AI model role: {role}"))?;
    let path = models_dir.join(&spec.filename);

    // A resident session keeps the file mapped on disk, so release first.
    let _guard = state.ai_init_lock.lock().await;
    reset_ai_sessions(&state.ai_state);

    if path.exists() {
        fs::remove_file(&path)
            .map_err(|error| format!("Failed to delete {}: {error}", spec.filename))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_URL: &str = "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/nind_denoise_utnet_684.onnx?download=true";

    #[test]
    fn candidate_urls_fall_back_to_mirror() {
        // Regression test for model downloads failing with
        // "error sending request" in regions where huggingface.co is blocked:
        // the official host must always be followed by the mirror.
        // No other test reads this variable, so clearing it is race-free.
        unsafe { std::env::remove_var(HF_ENDPOINT_ENV) };
        let urls = candidate_urls(TEST_URL);
        assert_eq!(
            urls,
            vec![
                TEST_URL.to_string(),
                format!(
                    "{HF_FALLBACK_HOST}/CyberTimon/RapidRAW-Models/resolve/main/nind_denoise_utnet_684.onnx?download=true"
                ),
            ]
        );
    }

    #[test]
    fn candidate_urls_pass_through_foreign_hosts() {
        let urls = candidate_urls("https://example.com/model.onnx");
        assert_eq!(urls, vec!["https://example.com/model.onnx".to_string()]);
    }

    #[test]
    fn denoise_asset_hash_is_pinned() {
        // Guards against a typo in the checksum that would make every
        // download fail verification.
        assert_eq!(DENOISE_ASSET.sha256, Some(DENOISE_SHA256));
        assert_eq!(DENOISE_ASSET.filename, DENOISE_FILENAME);
    }

    #[test]
    fn lama_output_scale_detects_range_from_output() {
        // 0-255 量程：除以 255（旧代码硬编码假设，现由输出自检得出）
        let (scale, offset) = lama_output_scale(0.0, 255.0);
        assert!((scale - 1.0 / 255.0).abs() < 1e-9);
        assert_eq!(offset, 0.0);
        // [0,1] 量程：原样（fp16 轻微过冲 1.0009 仍判 [0,1]）
        assert_eq!(lama_output_scale(0.0, 1.0), (1.0, 0.0));
        assert_eq!(lama_output_scale(0.0, 1.0009), (1.0, 0.0));
        // [-1,1] 量程：*0.5 + 0.5
        assert_eq!(lama_output_scale(-1.0, 1.0), (0.5, 0.5));
        // 全黑输出（max=0）：与 0-255 全黑归一化结果一致（都归零）
        assert_eq!(lama_output_scale(0.0, 0.0), (1.0, 0.0));
        // 判据边界：合法 [0,1] 不可能 >1.05
        assert_ne!(lama_output_scale(0.0, 1.06), (1.0, 0.0));
    }

    #[test]
    fn lama_guidance_only_above_hole_ratio_threshold() {
        // 洞区占窗口 10%（参照仓库单路障碍物口径）→ 放行
        assert_eq!(lama_guidance_hole_ratio(1_000, 100, 100), None);
        // 恰好等于阈值 → 放行（严格大于才引导）
        let at_threshold = (0.35 * 100.0 * 100.0) as u64;
        assert_eq!(lama_guidance_hole_ratio(at_threshold, 100, 100), None);
        // 超过阈值（参照仓库多紧挨障碍物 ~29% 起需引导，这里取 40%）→ 引导
        let ratio = lama_guidance_hole_ratio(4_000, 100, 100);
        assert!(ratio.is_some_and(|r| (r - 0.4).abs() < 1e-6));
    }

    #[test]
    fn percentile_mask_remap_adapts_to_confidence_scale() {
        // 强置信（p99≈0.9）：按 [0, 0.9] 归一，软边缘保留梯度（旧的固定
        // 阈值会把 <0.3 的边缘直接削平）
        let strong: Vec<f32> = (0..1000).map(|i| i as f32 / 1000.0 * 0.9).collect();
        let hi = percentile_mask_remap(&strong).expect("strong signal should adapt");
        // rank = round(999 * 0.99) = 989 → 989/999 × 0.9 ≈ 0.890
        assert!((hi - 0.890).abs() < 0.01, "p99 of ramp to 0.9, got {hi}");
        // 弱置信对象（峰值仅 0.45）：仍自适应放大到满值——固定阈值会把它
        // 压成 0.375 的近透明掩膜
        let weak: Vec<f32> = (0..1000).map(|i| i as f32 / 1000.0 * 0.45).collect();
        let hi = percentile_mask_remap(&weak).expect("weak-but-real signal should adapt");
        assert!((hi - 0.445).abs() < 0.01, "got {hi}");
        // 无真实信号（p99 ≤ 0.3）：维持固定阈值行为
        let noise: Vec<f32> = (0..1000).map(|i| i as f32 / 1000.0 * 0.2).collect();
        assert_eq!(percentile_mask_remap(&noise), None);
        // 全零（无 query 命中）
        assert_eq!(percentile_mask_remap(&[0.0; 100]), None);
        assert_eq!(percentile_mask_remap(&[]), None);
    }

    /// P1-3：tile 稳定性专项——任意边长下每个像素都必须被至少一个 tile
    /// 的有效区覆盖（否则累积器该像素权重为 0，输出黑洞/花屏）。
    #[test]
    fn denoise_tiling_covers_every_pixel() {
        let valid = DENOISE_TILE.cs - 2 * DENOISE_TILE.margin;
        let weights = tile_blend_weights(DENOISE_TILE);
        // 混合权重必须是 (0,1] 的 smoothstep 对称斜坡：两端渐隐、中间为 1
        let n = weights.len();
        assert!(weights.iter().all(|&w| w > 0.0 && w <= 1.0));
        assert!(weights[0] < 0.1 && weights[n - 1] < 0.1, "edges must feather out");
        assert!((weights[n / 2] - 1.0).abs() < 1e-6, "center must be full weight");
        for i in 0..n {
            assert!((weights[i] - weights[n - 1 - i]).abs() < 1e-6, "weights must be symmetric");
        }
        for &len in &[1usize, 100, 479, 480, 481, 500, 1000, 4096, 6000] {
            let origins = tile_origins(len, DENOISE_TILE);
            let mut covered = vec![false; len];
            for &o in &origins {
                for i in 0..valid {
                    let g = o + DENOISE_TILE.margin as i32 + i as i32;
                    if (0..len as i32).contains(&g) {
                        covered[g as usize] = true;
                    }
                }
            }
            assert!(
                covered.iter().all(|&c| c),
                "len {len} has pixels with zero blend weight"
            );
        }
    }

    /// P0-3：诊断结构 ↔ 前端契约——serde 序列化必须输出 camelCase 键名，
    /// Option 字段在 None 时整体省略（前端 TS 接口以可选字段消费）。该
    /// 契约由 DataManagementSettings.tsx 的 AiDiagnostics/AiModelDiagnostic
    /// 接口镜像，任何一侧改名都会让诊断面板静默显示 undefined，故钉死。
    #[test]
    fn diagnostics_serialization_matches_frontend_camel_case_contract() {
        let model = AiModelDiagnostic {
            role: "clip".into(),
            display_name: "CLIP".into(),
            filename: "clip_model.onnx".into(),
            installed: true,
            installed_bytes: Some(123),
            path: "/models/clip_model.onnx".into(),
            effective_ep: "CPU".into(),
            sha256_status: "ok".into(),
            session_build_ms: Some(42),
            probe_inference_ms: None,
            note: None,
        };
        let value = serde_json::to_value(&model).unwrap();
        assert_eq!(value["role"], "clip");
        assert_eq!(value["displayName"], "CLIP");
        assert_eq!(value["installedBytes"], 123);
        assert_eq!(value["effectiveEp"], "CPU");
        assert_eq!(value["sha256Status"], "ok");
        assert_eq!(value["sessionBuildMs"], 42);
        // None 的可选字段必须整体省略（而不是序列化成 null）
        assert!(value.get("probeInferenceMs").is_none());
        assert!(value.get("note").is_none());

        let diagnostics = AiDiagnostics {
            app_version: "2.1.16".into(),
            platform: "linux".into(),
            platform_gpu_ep: "none".into(),
            gpu_enabled_setting: false,
            gpu_runtime_status: "idle".into(),
            deep: true,
            models_dir: "/models".into(),
            device_tier: "desktop".into(),
            cpu_cores: 8,
            total_ram_mb: 16_384,
            intra_op_threads: "default".into(),
            models: vec![model],
            manifest_healthy: true,
            issues: vec![],
            recent_ai_logs: vec!["WARN clip session".into()],
        };
        let value = serde_json::to_value(&diagnostics).unwrap();
        for key in [
            "appVersion",
            "platform",
            "platformGpuEp",
            "gpuEnabledSetting",
            "gpuRuntimeStatus",
            "deep",
            "modelsDir",
            "deviceTier",
            "cpuCores",
            "totalRamMb",
            "intraOpThreads",
            "models",
            "manifestHealthy",
            "issues",
            "recentAiLogs",
        ] {
            assert!(value.get(key).is_some(), "missing key {key}");
        }
    }

    /// P0-3：EP 如实推导——按各模型初始化调用点的真实门槛路由。平台 EP
    /// 是显式参数，断言与测试宿主平台无关。
    #[test]
    fn model_effective_ep_routes_by_role_and_gpu_state() {
        // 非 ONNX 资产：n/a（无 EP 语义）
        assert_eq!(
            model_effective_ep("efficientsam_prompt", true, "DirectML", false),
            "n/a"
        );
        assert_eq!(
            model_effective_ep("clip_tokenizer", true, "DirectML", false),
            "n/a"
        );
        // GPU 开关关闭 / 平台无 EP / 运行时失败：一律 CPU
        assert_eq!(model_effective_ep("denoise", false, "DirectML", false), "CPU");
        assert_eq!(model_effective_ep("denoise", true, "none", false), "CPU");
        assert_eq!(model_effective_ep("denoise", true, "DirectML", true), "CPU");
        // 固定 CPU 路径的模型（调用点固定传 false 或本身就是 CPU 回退档）
        for role in [
            "sam_encoder",
            "sam_decoder",
            "face_landmarks",
            "face_segmenter",
            "lama",
            "efficientsam_text_encoder",
            "foreground_fp32",
        ] {
            assert_eq!(
                model_effective_ep(role, true, "DirectML", false),
                "CPU",
                "{role}"
            );
        }
        // 平台门控组：macOS 即便开关打开也走 CPU，其余平台按平台 EP
        let gated_expected = if cfg!(target_os = "macos") { "CPU" } else { "DirectML" };
        for role in [
            "foreground_fp16",
            "efficientsam_encoder",
            "efficientsam_decoder",
            "normal",
            "clip",
        ] {
            assert_eq!(
                model_effective_ep(role, true, "DirectML", false),
                gated_expected,
                "{role}"
            );
        }
        // 其余（denoise/depth）：跟随开关与运行时状态
        assert_eq!(model_effective_ep("denoise", true, "DirectML", false), "DirectML");
        assert_eq!(model_effective_ep("depth", true, "CoreML", false), "CoreML");
    }

    /// P0-3：平台 EP 与 GPU 状态标签只能是有限集合内的值（诊断报告的
    /// 消费方按这些字面量渲染），集合外的值会静默显示为未知状态。
    #[test]
    fn platform_ep_and_gpu_status_labels_are_from_known_sets() {
        assert!(["DirectML", "CoreML", "none"].contains(&platform_gpu_ep()));
        assert!(["idle", "active", "failed"].contains(&gpu_status_label()));
    }

    /// P0-2：会话构建线程注入口径——Android 分档返回 1~2，桌面 None。
    /// （数值端已在 ai_perf::tests 钉死；此处钉的是 create_session 的
    /// 消费口径：None = 保持 ORT 默认，不调用 with_intra_threads。）
    #[test]
    fn mobile_thread_budget_matches_ai_perf_policy() {
        match crate::ai_perf::mobile_intra_threads() {
            Some(threads) => {
                assert!((1..=2).contains(&threads));
                assert_eq!(threads, crate::ai_perf::intra_op_threads_label().parse::<usize>().unwrap());
            }
            None => assert_eq!(crate::ai_perf::intra_op_threads_label(), "default"),
        }
    }
}
