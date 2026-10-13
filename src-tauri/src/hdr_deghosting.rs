use crate::alignment_core::{self, FrameDetection};
use crate::app_settings::AppSettings;
use crate::exif_processing::{read_exposure_time_secs, read_iso};
use crate::formats::is_raw_file;
use crate::image_loader::load_base_image_from_bytes;
use crate::image_processing::apply_srgb_to_linear;
use crate::panorama_utils::processing;
use image::{DynamicImage, GenericImageView};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

pub type HdrFrame = (String, DynamicImage, Duration, f32);

const DEGHOST_FAST_THRESHOLD: u8 = 8;
const DEGHOST_NON_MAXIMA_SUPPRESSION_RADIUS: f32 = 8.0;
const DEGHOST_MAX_PROCESSING_DIMENSION: u32 = 3200;
const DEGHOST_IDENTITY_MAX_DISPLACEMENT: f64 = 1.0;

pub fn load_hdr_frames(
    paths: &[String],
    settings: &AppSettings,
    progress: &dyn Fn(&str),
    cancel: &AtomicBool,
) -> Result<Vec<HdrFrame>, String> {
    assert!(paths.len() >= 2, "hdr merge requires at least two paths");
    let mut frames = Vec::with_capacity(paths.len());
    for path in paths {
        if cancel.load(Ordering::SeqCst) {
            return Err(crate::compose_queue::CANCELLED_MSG.to_string());
        }
        progress(&format!(
            "Processing '{}'",
            Path::new(path)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
        ));
        let file_bytes =
            fs::read(path).map_err(|e| format!("Failed to read image {}: {}", path, e))?;
        let mut dynamic_image =
            load_base_image_from_bytes(&file_bytes, path, false, settings, None)
                .map_err(|e| format!("Failed to load image {}: {}", path, e))?;
        if !is_raw_file(path) {
            dynamic_image = apply_srgb_to_linear(dynamic_image);
        }
        let gains = match read_iso(path, &file_bytes) {
            None => return Err(format!("Image {} is missing ISO/Sensitivity data", path)),
            Some(gains) => gains as f32,
        };
        let exposure = match read_exposure_time_secs(path, &file_bytes) {
            None => return Err(format!("Image {} is missing ExposureTime data", path)),
            Some(exp) => Duration::from_secs_f32(exp),
        };
        frames.push((path.clone(), dynamic_image, exposure, gains));
    }
    Ok(frames)
}

pub fn assert_uniform_dimensions(frames: &[HdrFrame]) -> Result<(), String> {
    assert!(
        !frames.is_empty(),
        "dimension check requires at least one frame"
    );
    let (first_path, first_image, _, _) = &frames[0];
    let width = first_image.width();
    let height = first_image.height();
    for (path, image, _, _) in frames.iter().skip(1) {
        if image.width() != width || image.height() != height {
            return Err(format!(
                "Dimension mismatch detected.\n\nBase image ({}): {}x{}\nTarget image ({}): {}x{}\n\nHDR merge requires all images to be exactly the same size.",
                Path::new(first_path)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy(),
                width,
                height,
                Path::new(path)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy(),
                image.width(),
                image.height()
            ));
        }
    }
    Ok(())
}

pub fn align_hdr_frames(
    frames: &mut [HdrFrame],
    progress: &dyn Fn(&str),
    cancel: &AtomicBool,
) -> Result<(), String> {
    assert!(!frames.is_empty(), "alignment requires at least one frame");
    progress("Deghosting...");
    let brief_pairs = processing::generate_brief_pairs();
    let reference_index = frames.len() / 2;
    let detections: Vec<FrameDetection> = frames
        .iter()
        .map(|frame| {
            alignment_core::detect_frame_features(
                &frame.1,
                &brief_pairs,
                DEGHOST_FAST_THRESHOLD,
                DEGHOST_NON_MAXIMA_SUPPRESSION_RADIUS,
                DEGHOST_MAX_PROCESSING_DIMENSION,
                is_raw_file(&frame.0),
            )
        })
        .collect();
    for index in 0..frames.len() {
        if cancel.load(Ordering::SeqCst) {
            return Err(crate::compose_queue::CANCELLED_MSG.to_string());
        }
        if index == reference_index {
            continue;
        }
        let file_name = Path::new(&frames[index].0)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        progress(&format!("Aligning '{}'...", file_name));
        let outcome = alignment_core::align_frame_to_reference(
            &frames[index].1,
            &detections[index],
            &detections[reference_index],
            DEGHOST_IDENTITY_MAX_DISPLACEMENT,
        );
        match outcome {
            alignment_core::AlignmentOutcome::Warped(warped) => {
                frames[index].1 = DynamicImage::ImageRgb32F(warped);
            }
            alignment_core::AlignmentOutcome::AlreadyAligned => {}
            alignment_core::AlignmentOutcome::Failed => {
                progress(&format!("Could not align '{}', using as-is", file_name));
            }
        }
    }
    Ok(())
}
