// Subunit Meet REST client — 1:1 with the live endpoints (transcribe.subunit.ai).
// Thin typed wrappers around fetch; callers handle the dynamic JSON shapes (kept `any`
// to mirror the vanilla, which reads fields opportunistically).
/* eslint-disable @typescript-eslint/no-explicit-any */
export const API = "https://transcribe.subunit.ai";
export const WSB = "wss://transcribe.subunit.ai";

type Json = any;

async function asJson(r: Response): Promise<Json> {
  return r.json().catch(() => ({}));
}

export interface CreateMeetingBody {
  host_name: string | null;
  host_email: string | null;
  title: string;
  mode: string;
  device_mode: string;
  expected_speakers: number | null;
  speaker_names: string[];
  language: string;
}

/** Host: allocate a meeting (Bearer = subunit access token). */
export async function createMeeting(jwt: string, body: CreateMeetingBody) {
  const r = await fetch(`${API}/v1/meetings`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + jwt },
    body: JSON.stringify(body),
  });
  return { ok: r.ok, status: r.status, data: await asJson(r) };
}

/** Join a meeting (host with host_token+source:"host", or guest with name/email). */
export async function joinMeeting(
  code: string,
  body: { name: string; email: string; source: string; host_token?: string; ui_lang: string },
) {
  const r = await fetch(`${API}/v1/meetings/${code}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { ok: r.ok, status: r.status, data: await asJson(r) };
}

export async function meetingInfo(code: string): Promise<Json | null> {
  try {
    const r = await fetch(`${API}/v1/meetings/${code}/info`);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

export async function participants(code: string, hostToken: string): Promise<Json | null> {
  try {
    const r = await fetch(`${API}/v1/meetings/${code}/participants`, {
      headers: { "X-Host-Token": hostToken },
    });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

export async function approveParticipant(code: string, hostToken: string, token: string, ok: boolean) {
  try {
    await fetch(`${API}/v1/meetings/${code}/participants/${token}/${ok ? "approve" : "reject"}`, {
      method: "POST",
      headers: { "X-Host-Token": hostToken },
    });
  } catch {
    /* ignore */
  }
}

export async function startMeeting(code: string, hostToken: string) {
  try {
    await fetch(`${API}/v1/meetings/${code}/start`, { method: "POST", headers: { "X-Host-Token": hostToken } });
  } catch {
    /* ignore */
  }
}

export async function endMeeting(code: string, hostToken: string) {
  try {
    await fetch(`${API}/v1/meetings/${code}/end`, { method: "POST", headers: { "X-Host-Token": hostToken } });
  } catch {
    /* ignore */
  }
}

export async function guestStatus(code: string, joinToken: string): Promise<{ status: number; data: Json } | null> {
  try {
    const r = await fetch(`${API}/v1/meetings/${code}/me?t=${encodeURIComponent(joinToken)}`);
    return { status: r.status, data: await asJson(r) };
  } catch {
    return null;
  }
}

// ---- Pod voice-enrollment ----
export async function enrollState(code: string, token: string): Promise<Json | null> {
  try {
    const r = await fetch(`${API}/v1/meetings/${code}/enroll/state?t=${encodeURIComponent(token)}`);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}
export async function enrollStart(code: string, hostToken: string) {
  try {
    await fetch(`${API}/v1/meetings/${code}/enroll/start`, { method: "POST", headers: { "X-Host-Token": hostToken } });
  } catch {
    /* ignore */
  }
}
export async function enrollMark(code: string, hostToken: string, token: string, status: string) {
  try {
    await fetch(`${API}/v1/meetings/${code}/enroll/mark/${token}?status=${status}`, {
      method: "POST",
      headers: { "X-Host-Token": hostToken },
    });
  } catch {
    /* ignore */
  }
}

// ---- Results ----
export async function transcript(code: string, token: string): Promise<Json | null> {
  try {
    const r = await fetch(`${API}/v1/meetings/${code}/transcript?t=${encodeURIComponent(token)}`);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}
export async function requestTranslate(code: string, hostToken: string, lang: string) {
  try {
    await fetch(`${API}/v1/meetings/${code}/translate/${lang}`, { method: "POST", headers: { "X-Host-Token": hostToken } });
  } catch {
    /* ignore */
  }
}
export async function protocol(code: string, lang: string, token: string): Promise<Json> {
  const r = await fetch(`${API}/v1/meetings/${code}/protocol?lang=${encodeURIComponent(lang)}&t=${encodeURIComponent(token)}`);
  return asJson(r);
}
export async function sendRecap(
  code: string,
  hostToken: string,
  recipients: { token: string; email: string; lang: string }[],
) {
  const r = await fetch(`${API}/v1/meetings/${code}/send-recap`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Host-Token": hostToken },
    body: JSON.stringify({ recipients }),
  });
  return { ok: r.ok, data: await asJson(r) };
}
export async function intel(code: string, action: string, jwt: string, hostToken: string) {
  const r = await fetch(`${API}/v1/meetings/${code}/intel/${action}`, {
    method: "POST",
    headers: { authorization: "Bearer " + (jwt || ""), "X-Host-Token": hostToken || "" },
  });
  return { ok: r.ok, status: r.status };
}
