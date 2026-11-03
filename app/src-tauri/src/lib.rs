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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![clipboard_image])
        .run(tauri::generate_context!())
        .expect("error while running Augur");
}
