//! Task 0 PoC — lavapipe 软件渲染跑通 wgpu 管线（spec: v2-engine-contract-tests, TR-0.1）
//!
//! 本测试是 go/no-go 门：验证 CI（ubuntu，无实体 GPU）环境可用 mesa lavapipe
//! 软件渲染驱动 wgpu 计算管线，为后续 CPU/GPU 一致性 harness 提供可行性依据。
//!
//! 运行方式（CI / 本机）：
//! ```sh
//! apt-get install -y mesa-vulkan-drivers
//! VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.json WGPU_BACKEND=vulkan \
//!   cargo test --test gpu_poc
//! ```
//!
//! 两层验证：
//! 1. `lavapipe_compute_poc`：adapter/device 可用 + 最小 compute dispatch 数值正确
//!    （证明软件渲染栈端到端完整）；
//! 2. `existing_shaders_compile`：现有 4 个 WGSL shader 在当前 wgpu 版本下编译通过
//!    （证明契约 harness 可直接消费管线资产）。
//!
//! 无 GPU/无 lavapipe 环境 adapter 请求失败时按 skip 处理（不算失败），
//! CI 是否真的跑到了由 Task 6 workflow 的输出断言保证。

use wgpu::{
    Backends, DeviceDescriptor, ExperimentalFeatures, Features, InstanceDescriptor, InstanceFlags,
    MemoryHints, PollType,
};

fn make_instance() -> wgpu::Instance {
    let mut desc = InstanceDescriptor::new_without_display_handle_from_env();
    desc.backends = match std::env::var("WGPU_BACKEND").as_deref() {
        Ok("vulkan") => Backends::VULKAN,
        Ok("gl") => Backends::GL,
        Ok("metal") => Backends::METAL,
        Ok("dx12") => Backends::DX12,
        _ => Backends::all(),
    };
    // 静默验证日志，避免 CI 输出噪音
    desc.flags = InstanceFlags::empty();
    wgpu::Instance::new(desc)
}

fn request_gpu() -> Option<(wgpu::Adapter, wgpu::Device, wgpu::Queue)> {
    let instance = make_instance();
    let adapter =
        pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))
            .ok()?;
    let (device, queue) = pollster::block_on(adapter.request_device(&DeviceDescriptor {
        label: Some("gpu-poc-device"),
        required_features: Features::empty(),
        required_limits: adapter.limits().clone(),
        experimental_features: ExperimentalFeatures::default(),
        memory_hints: MemoryHints::MemoryUsage,
        trace: wgpu::Trace::Off,
    }))
    .ok()?;
    Some((adapter, device, queue))
}

/// 64×64 f32 缓冲 +1 偏移的完整 dispatch → 读回校验
#[test]
fn lavapipe_compute_poc() {
    let Some((adapter, device, queue)) = request_gpu() else {
        println!(
            "SKIP: no wgpu adapter available (no GPU / lavapipe). Install mesa-vulkan-drivers."
        );
        return;
    };
    let info = adapter.get_info();
    println!(
        "PoC running on adapter: {} ({:?}, {:?})",
        info.name, info.backend, info.device_type
    );

    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("poc-add-one"),
        source: wgpu::ShaderSource::Wgsl(
            r#"
            @group(0) @binding(0) var<storage, read> src: array<f32>;
            @group(0) @binding(1) var<storage, read_write> dst: array<f32>;

            @compute @workgroup_size(8, 8)
            fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
                let idx = gid.y * 64u + gid.x;
                dst[idx] = src[idx] + 1.0;
            }
        "#
            .into(),
        ),
    });

    let size: u64 = (64usize * 64usize * std::mem::size_of::<f32>()) as u64;
    let src_values: Vec<f32> = (0..64 * 64).map(|i| (i % 256) as f32).collect();

    let src_buf = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("poc-src"),
        size,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    queue.write_buffer(&src_buf, 0, bytemuck::cast_slice(&src_values));

    let dst_buf = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("poc-dst"),
        size,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("poc-readback"),
        size,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });

    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("poc-pipeline"),
        layout: None,
        module: &shader,
        entry_point: Some("main"),
        compilation_options: Default::default(),
        cache: None,
    });

    let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("poc-bind-group"),
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: src_buf.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: dst_buf.as_entire_binding(),
            },
        ],
    });

    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("poc-encoder"),
    });
    {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: None,
            ..Default::default()
        });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &bind_group, &[]);
        pass.dispatch_workgroups(8, 8, 1);
    }
    encoder.copy_buffer_to_buffer(&dst_buf, 0, &readback, 0, Some(size));
    queue.submit(Some(encoder.finish()));
    device
        .poll(PollType::wait_indefinitely())
        .expect("device poll");

    let slice = readback.slice(..);
    let (tx, rx) = std::sync::mpsc::channel();
    slice.map_async(wgpu::MapMode::Read, move |result| {
        tx.send(result).expect("map callback channel");
    });
    device
        .poll(PollType::wait_indefinitely())
        .expect("device poll after map");
    rx.recv().expect("map result").expect("buffer map failed");

    let mapping = slice.get_mapped_range();
    let out: &[f32] = bytemuck::cast_slice(&mapping);
    assert_eq!(out.len(), 64 * 64, "output element count mismatch");
    for (i, v) in out.iter().enumerate() {
        let expected = (i % 256) as f32 + 1.0;
        assert!(
            (v - expected).abs() < 1e-6,
            "element {i}: got {v}, expected {expected}"
        );
    }
    drop(mapping);
    readback.unmap();
    println!(
        "PoC dispatch OK: 4096/4096 elements correct on {}",
        info.name
    );
}

/// 现有 4 个 WGSL shader 在当前 wgpu 版本下编译验证（错误经 error scope 捕获）
#[test]
fn existing_shaders_compile() {
    let Some((_adapter, device, _queue)) = request_gpu() else {
        println!(
            "SKIP: no wgpu adapter available (no GPU / lavapipe). Install mesa-vulkan-drivers."
        );
        return;
    };

    const SHADERS: [&str; 4] = [
        "src/shaders/shader.wgsl",
        "src/shaders/blur.wgsl",
        "src/shaders/display.wgsl",
        "src/shaders/flare.wgsl",
    ];

    for path in SHADERS {
        let full = format!("{}/{}", env!("CARGO_MANIFEST_DIR"), path);
        let source = std::fs::read_to_string(&full)
            .unwrap_or_else(|e| panic!("cannot read shader {full}: {e}"));

        let guard = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let _module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some(path),
            source: wgpu::ShaderSource::Wgsl(source.into()),
        });
        let err = pollster::block_on(guard.pop());
        assert!(err.is_none(), "shader {path} failed to compile: {err:?}");
        println!("shader {path} compiled OK");
    }
}
