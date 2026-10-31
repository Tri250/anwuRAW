//! Temporary spike: encoder-level timestamp queries on lavapipe.
use std::sync::Arc;

fn main() {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        ..Default::default()
    }))
    .expect("no adapter");
    let feats = wgpu::Features::TIMESTAMP_QUERY | wgpu::Features::TIMESTAMP_QUERY_INSIDE_ENCODERS;
    println!("INSIDE_ENCODERS supported: {}", adapter.features().contains(feats));
    if !adapter.features().contains(feats) {
        return;
    }
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("spike"),
        required_features: feats,
        required_limits: adapter.limits(),
        ..Default::default()
    }))
    .expect("device");
    let device = Arc::new(device);
    let qs = device.create_query_set(&wgpu::QuerySetDescriptor {
        label: Some("spike qs"),
        ty: wgpu::QueryType::Timestamp,
        count: 4,
    });
    let buf = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("spike resolve"),
        size: 32,
        usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let read_buf = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("spike read"),
        size: 32,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("spike shader"),
        source: wgpu::ShaderSource::Wgsl(std::borrow::Cow::Borrowed(
            "@compute @workgroup_size(1) fn main() {}",
        )),
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("spike pipeline"),
        layout: None,
        module: &module,
        entry_point: Some("main"),
        compilation_options: Default::default(),
        cache: None,
    });
    println!("timestamp period: {}", queue.get_timestamp_period());
    let mut encoder = device.create_command_encoder(&Default::default());
    encoder.write_timestamp(&qs, 0);
    {
        let mut pass = encoder.begin_compute_pass(&Default::default());
        pass.set_pipeline(&pipeline);
        pass.dispatch_workgroups(64, 64, 64);
    }
    encoder.write_timestamp(&qs, 1);
    {
        let mut pass = encoder.begin_compute_pass(&Default::default());
        pass.set_pipeline(&pipeline);
        pass.dispatch_workgroups(64, 64, 64);
    }
    encoder.write_timestamp(&qs, 2);
    // A second encoder in the same submission order.
    let mut encoder2 = device.create_command_encoder(&Default::default());
    encoder2.write_timestamp(&qs, 3);
    queue.submit([encoder.finish(), encoder2.finish()]);
    let mut resolve_encoder = device.create_command_encoder(&Default::default());
    resolve_encoder.resolve_query_set(&qs, 0..4, &buf, 0);
    resolve_encoder.copy_buffer_to_buffer(&buf, 0, &read_buf, 0, 32);
    queue.submit([resolve_encoder.finish()]);
    let slice = read_buf.slice(..);
    let (tx, rx) = std::sync::mpsc::channel();
    slice.map_async(wgpu::MapMode::Read, move |r| {
        let _ = tx.send(r);
    });
    device.poll(wgpu::PollType::Wait {
        submission_index: None,
        timeout: Some(std::time::Duration::from_secs(5)),
    })
    .expect("poll failed");
    rx.recv().unwrap().expect("map failed");
    let data = slice.get_mapped_range();
    let t: Vec<u64> = data.chunks_exact(8).map(|c| u64::from_le_bytes(c.try_into().unwrap())).collect();
    let period = queue.get_timestamp_period() as f64;
    println!("t = {t:?}");
    println!("pass1 = {:.1} us, pass2 = {:.1} us, cross-encoder gap = {:.1} us",
        (t[1]-t[0]) as f64 * period / 1000.0,
        (t[2]-t[1]) as f64 * period / 1000.0,
        (t[3]-t[2]) as f64 * period / 1000.0);
}
