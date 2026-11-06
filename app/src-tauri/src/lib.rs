use tauri::ipc::Response;

/// Read an image from the OS clipboard. Returns [width u32 LE][height u32 LE][RGBA bytes].
/// WebKit webviews don't always surface pasted images to JS, so the app asks natively.
#[tauri::command]
fn clipboard_image() -> Result<Response, String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    let img = cb.get_image().map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(8 + img.bytes.len());
    out.extend_from_slice(&(img.width as u32).to_le_bytes());
    out.extend_from_slice(&(img.height as u32).to_le_bytes());
    out.extend_from_slice(&img.bytes);
    Ok(Response::new(out))
}

/// Linux low-end / no-GPU fallback. WebKitGTK's DMA-BUF renderer and GPU compositing cause blank or glitchy
/// windows on machines with weak, missing or unsupported GPUs (VMs, old Intel, some NVIDIA drivers).
/// Use the CPU-friendly paths unless the user has chosen otherwise. AUGUR_GPU=1 keeps full acceleration.
#[cfg(target_os = "linux")]
fn linux_render_fallback() {
    use std::env;
    if env::var_os("AUGUR_GPU").is_some() {
        return;
    }
    let has_gpu = std::fs::read_dir("/dev/dri")
        .map(|d| d.flatten().any(|e| e.file_name().to_string_lossy().starts_with("renderD")))
        .unwrap_or(false);
    // SAFETY: called first thing in `run`, before Tauri or WebKit start any threads.
    unsafe {
        if env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
        if !has_gpu && env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_none() {
            env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    linux_render_fallback();
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![clipboard_image])
        .run(tauri::generate_context!())
        .expect("error while running Augur");
}
