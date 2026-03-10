import { RIVET_API_BASE_URL } from './hosted-env';
const API = RIVET_API_BASE_URL;
async function apiPost(endpoint, body) {
    const response = await fetch(`${API}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        throw new Error(`API error: ${response.statusText}`);
    }
    return response.json();
}
export async function apiReadText(path) {
    const data = await apiPost('/native/read-text', { path });
    return data.contents;
}
export async function apiWriteText(path, contents) {
    await apiPost('/native/write-text', { path, contents });
}
export async function apiReadBinary(path) {
    const data = await apiPost('/native/read-binary', { path });
    const binary = atob(data.contents);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}
export async function apiExists(path) {
    try {
        const data = await apiPost('/native/exists', { path });
        return data.exists;
    }
    catch {
        return false;
    }
}
