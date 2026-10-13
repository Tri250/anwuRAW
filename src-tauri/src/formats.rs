use std::convert::AsRef;
use std::path::Path;

pub const RAW_EXTENSIONS: &[(&str, &str)] = &[
    // Adobe
    ("dng", "Adobe Digital Negative"),
    // Apple
    ("pro", "Apple ProRAW"),
    // Arri
    ("ari", "ARRI Raw"),
    // Canon
    ("crw", "Canon Raw"),
    ("cr2", "Canon Raw 2"),
    ("cr3", "Canon Raw 3"),
    // Casio
    ("bay", "Casio"),
    // Contax
    ("raw", "Contax"),
    // DJI
    // ("dng", "DJI (uses DNG)"), // Covered by Adobe

    // Epson
    ("erf", "Epson Raw"),
    // Fuji
    ("raf", "Fuji Raw"),
    // Hasselblad
    ("3fr", "Hasselblad"),
    ("fff", "Hasselblad"),
    // Imacon / Phase One
    ("iiq", "Imacon/Phase One"),
    // Kodak
    ("kdc", "Kodak"),
    ("k25", "Kodak"),
    ("dcs", "Kodak"),
    ("dcr", "Kodak"),
    // Leaf
    ("mos", "Leaf"),
    // Leica
    ("rwl", "Leica Raw"),
    // ("dng", "Leica (uses DNG)"), // Covered by Adobe

    // Mamiya
    ("mef", "Mamiya"),
    // Minolta
    ("mrw", "Minolta Raw"),
    // Nikon
    ("nef", "Nikon Electronic Format"),
    ("nrw", "Nikon Raw"),
    // Olympus
    ("orf", "Olympus Raw"),
    // Panasonic
    ("rw2", "Panasonic Raw 2"),
    ("raw", "Panasonic Raw"),
    // Pentax
    ("pef", "Pentax Electronic File"),
    ("ptx", "Pentax"),
    // Phase One
    // ("iiq", "Phase One (same as Imacon)"), // Covered by Imacon

    // Ricoh
    // ("dng", "Ricoh (uses DNG)"), // Covered by Adobe

    // Samsung
    ("srw", "Samsung Raw"),
    // Sigma
    ("x3f", "Sigma"),
    // Sony
    ("arw", "Sony Alpha Raw"),
    ("srf", "Sony Raw"),
    ("sr2", "Sony Raw 2"),
]; // Tell me if your's is missing.

pub const NON_RAW_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "bmp", "tiff", "tif", "webp", "jxl", // Standard formats
    "exr", "hdr", // High Dynamic Range / Wide Gamut
    "tga", "ico", "dds", // Graphics & Icons
    "qoi", "ff", // Simple/Specialist formats
    "pnm", "pbm", "pgm", "ppm", "pam", // Netpbm family
];

pub fn is_raw_file<P: AsRef<Path>>(path: P) -> bool {
    let ext = match path.as_ref().extension().and_then(|s| s.to_str()) {
        Some(e) => e,
        None => return false,
    };

    RAW_EXTENSIONS
        .iter()
        .any(|(raw_ext, _)| raw_ext.eq_ignore_ascii_case(ext))
}

pub fn is_supported_image_file<P: AsRef<Path>>(path: P) -> bool {
    let path = path.as_ref();

    if path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with('.'))
    {
        return false;
    }

    let ext = match path.extension().and_then(|s| s.to_str()) {
        Some(e) => e,
        None => return false,
    };

    if RAW_EXTENSIONS
        .iter()
        .any(|(raw_ext, _)| raw_ext.eq_ignore_ascii_case(ext))
    {
        return true;
    }

    NON_RAW_EXTENSIONS
        .iter()
        .any(|non_raw_ext| non_raw_ext.eq_ignore_ascii_case(ext))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 注册表数据完整性：描述非空、普通格式无重复。
    #[test]
    fn registry_entries_are_well_formed() {
        for &(ext, description) in RAW_EXTENSIONS {
            assert!(!ext.is_empty() && ext == ext.to_ascii_lowercase(), "ext must be lowercase: {ext}");
            assert!(!description.is_empty(), "{ext}: description required");
        }

        let mut non_raw: Vec<&&str> = NON_RAW_EXTENSIONS.iter().collect();
        non_raw.sort();
        let before = non_raw.len();
        non_raw.dedup();
        assert_eq!(before, non_raw.len(), "duplicate non-raw extension");
    }

    /// RAW 判定：代表厂商样例 + 大小写不敏感 + 非 RAW/无扩展名排除。
    #[test]
    fn raw_detection_matrix() {
        let raw_samples = [
            "IMG_0001.CR3",
            "DSC_1234.NEF",
            "a7r5.ARW",
            "capture.dng",
            "IMG_0001.ProRAW.pro",
            "pana.RW2",
            "fuji.RAF",
        ];
        for name in raw_samples {
            assert!(is_raw_file(name), "{name} should be raw");
            assert!(is_supported_image_file(name), "{name} should be supported");
        }

        for name in ["photo.JPG", "render.PNG", "anim.gif", "scan.tiff", "depth.exr"] {
            assert!(!is_raw_file(name), "{name} must not be raw");
            assert!(is_supported_image_file(name), "{name} should be supported");
        }

        for name in ["archive.zip", "notes.txt", "noext", ".hidden.png"] {
            assert!(!is_supported_image_file(name), "{name} must be rejected");
        }
    }

    /// 上游 `image` crate 支持的格式都应已注册（防新格式遗漏）。
    #[test]
    fn image_crate_formats_are_registered() {
        // image 0.25 能解码的扩展名采样（不含 exr/hdr 等已在表中的）
        let expected = ["jpg", "jpeg", "png", "gif", "bmp", "tiff", "tif", "webp", "qoi", "ff"];
        for ext in expected {
            assert!(
                NON_RAW_EXTENSIONS.contains(&ext),
                "{ext} supported by `image` crate but missing from NON_RAW_EXTENSIONS"
            );
        }
    }
}
