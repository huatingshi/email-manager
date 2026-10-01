// Calls the local API. Resolves to the parsed JSON body, or throws an Error
// whose message can be shown to the user as-is.
export async function api(path, { method = 'GET', body } = {}) {
  let response;
  let text;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    text = await response.text();
  } catch {
    throw new Error('无法连接本地服务，请确认程序仍在运行');
  }

  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const error = new Error(
      payload?.error ||
        (response.status >= 500
          ? '本地服务没有响应，请确认程序仍在运行'
          : `请求失败（HTTP ${response.status}）`)
    );
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}
