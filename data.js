// ──────────────────────────────────────────────────────────────
// COMAE 공통 데이터 계층 (Supabase)
// 고객용/관리자용 페이지가 함께 쓰는 DB · Storage · Auth · Edge Function 래퍼.
// 두 HTML 은 이 파일의 함수만 호출하므로, 백엔드가 바뀌어도 HTML 은 그대로입니다.
// ──────────────────────────────────────────────────────────────
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./supabase-config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── 조회 ────────────────────────────────────────────────────
export async function listOnce(table) {
  const { data, error } = await sb.from(table).select("*").order("created_at", { ascending: true });
  if (error) throw error;
  return data || [];
}

// 실시간 구독: 최초 1회 로드 후, 변경이 생길 때마다 cb(items) 재호출.
// 구독 해제 함수를 반환. (Realtime 미설정이어도 최초 로드는 동작)
export function listen(table, cb) {
  const fetchAll = async () => {
    const { data, error } = await sb.from(table).select("*").order("created_at", { ascending: true });
    if (error) { console.error(`[listen:${table}]`, error); return; }
    cb(data || []);
  };
  fetchAll();
  const channel = sb
    .channel(`rt-${table}`)
    .on("postgres_changes", { event: "*", schema: "public", table }, fetchAll)
    .subscribe();
  return () => sb.removeChannel(channel);
}

// ── 쓰기 ────────────────────────────────────────────────────
export async function addItem(table, obj) {
  // .select() 로 되읽지 않음 — 고객(anon)은 읽기 권한이 없어 되읽기 단계에서 실패하기 때문
  const { error } = await sb.from(table).insert(obj);
  if (error) throw error;
}
export async function updateItem(table, id, patch) {
  const { error } = await sb.from(table).update(patch).eq("id", id);
  if (error) throw error;
}
export async function removeItem(table, id) {
  const { data, error } = await sb.from(table).delete().eq("id", id).select("id");
  if (error) throw error;
  if (!data || data.length === 0) throw new Error("삭제 권한이 없거나 항목을 찾을 수 없습니다.");
}

// ── 사진 압축 (업로드 전 용량 절감) ──────────────────────────
// 가로/세로 최대 maxDim px 로 줄이고 JPEG 품질 quality 로 재인코딩.
// 이미지가 아니거나 변환 실패 시 원본을 그대로 반환.
async function compressImage(file, maxDim = 1280, quality = 0.7) {
  if (!file.type || !file.type.startsWith("image/")) return file;
  let bitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch (_) { return file; }
  let { width, height } = bitmap;
  if (width > maxDim || height > maxDim) {
    const r = Math.min(maxDim / width, maxDim / height);
    width = Math.round(width * r);
    height = Math.round(height * r);
  }
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
  const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", quality));
  // 압축본이 원본보다 크면 원본 사용
  return (blob && blob.size < file.size) ? blob : file;
}

// ── 사진 업로드 (Storage: photos 버킷) ──────────────────────
export async function uploadPhotos(folder, fileInput) {
  const files = [...(fileInput?.files || [])].slice(0, 30);
  const urls = [];
  for (const f of files) {
    const blob = await compressImage(f);
    const ct = blob.type || f.type || "image/jpeg";
    const ext = ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg";
    const path = `${folder}/${Date.now()}_${Math.random().toString(36).slice(2, 7)}.${ext}`;
    const { error } = await sb.storage.from("photos").upload(path, blob, { contentType: ct });
    if (error) throw error;
    urls.push(sb.storage.from("photos").getPublicUrl(path).data.publicUrl);
  }
  return urls;
}

// ── 파일 → 압축된 data URL 배열 (Storage 미사용, DB 직접저장용) ──
// 협력업체 신청은 익명 고객이 하므로 Storage(관리자 전용) 대신
// 사진을 압축해 partners 행에 직접 저장한다.
export async function filesToDataUrls(fileInput, max = 5) {
  const files = [...(fileInput?.files || [])].slice(0, max);
  const urls = [];
  for (const f of files) {
    const blob = await compressImage(f, 1400, 0.72);
    urls.push(await blobToDataUrl(blob));
  }
  return urls;
}
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

// ── 입찰 제안 (Postgres 함수 RPC 경유 — 고유번호 서버검증) ──────
export async function submitProposal(payload) {
  const { error } = await sb.rpc("submit_proposal", {
    p_bid_id: payload.bidId || null,
    p_code: payload.code || "",
    p_company: payload.company || "",
    p_role: payload.role || "",
    p_category: payload.category || "",
    p_price: payload.price || "",
    p_schedule: payload.schedule || "",
    p_as: payload.as || "",
    p_memo: payload.memo || "",
  });
  if (error) throw new Error(error.message || "입찰 제출에 실패했습니다.");
  return { ok: true };
}

// ── 입찰내역 조회 (업체명+고유번호 검증 후 그 업체 제안만 반환) ──
export async function lookupProposals(company, code) {
  const { data, error } = await sb.rpc("lookup_proposals", { p_company: company, p_code: code });
  if (error) throw new Error(error.message || "입찰내역 조회에 실패했습니다.");
  return data || [];
}

// ── 관리자 인증 ──────────────────────────────────────────────
export async function login(email, password) {
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
}
export async function logout() {
  await sb.auth.signOut();
}
export function onAuth(cb) {
  sb.auth.getSession().then(({ data }) => cb(data.session ? data.session.user : null));
  const { data: sub } = sb.auth.onAuthStateChange((_e, session) => cb(session ? session.user : null));
  return () => sub.subscription.unsubscribe();
}

// 현재 로그인한 관리자의 권한('boss' | 'staff' | null) 조회
export async function myAdminRole() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return null;
  const { data } = await sb.from("admins").select("role").eq("id", user.id).maybeSingle();
  return data ? (data.role || "staff") : null;
}

// ── 직원 계정 관리 (사장 전용 — 서버에서 is_boss() 검증) ────────
export async function listStaff() {
  const { data, error } = await sb.rpc("admin_list_staff");
  if (error) throw error;
  return data || [];
}
export async function createStaff(email, password) {
  const { data, error } = await sb.rpc("admin_create_staff", { p_email: email, p_password: password });
  if (error) throw error;
  return data;
}
export async function setStaffPassword(id, password) {
  const { error } = await sb.rpc("admin_set_staff_password", { p_id: id, p_password: password });
  if (error) throw error;
}
export async function setStaffEmail(id, email) {
  const { error } = await sb.rpc("admin_set_staff_email", { p_id: id, p_email: email });
  if (error) throw error;
}
export async function deleteStaff(id) {
  const { error } = await sb.rpc("admin_delete_staff", { p_id: id });
  if (error) throw error;
}

// ── 백업 / 복원 ──────────────────────────────────────────────
const BACKUP_TABLES = ["reservations", "partners", "bids", "proposals", "daily", "reports"];
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

// 현재 전체 데이터를 스냅샷으로 backups 테이블에 저장
export async function saveBackup(label) {
  const data = {};
  for (const t of BACKUP_TABLES) {
    const { data: rows, error } = await sb.from(t).select("*");
    if (error) throw error;
    data[t] = rows || [];
  }
  const { error } = await sb.from("backups").insert({ label: label || null, data });
  if (error) throw error;
}

// 저장된 백업 목록(데이터 본문 제외, 최신순)
export async function listBackups() {
  const { data, error } = await sb.from("backups")
    .select("id, created_at, label").order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

// 백업 1건 삭제
export async function deleteBackup(id) {
  const { error } = await sb.from("backups").delete().eq("id", id);
  if (error) throw error;
}

// 백업 1건의 전체 내용(다운로드용)
export async function getBackup(id) {
  const { data, error } = await sb.from("backups").select("label, created_at, data").eq("id", id).single();
  if (error) throw error;
  return data;
}

// ── 환경설정(보관 정책 등) ───────────────────────────────────
export async function getSettings() {
  const { data, error } = await sb.from("settings").select("key, value");
  if (error) throw error;
  const o = {}; (data || []).forEach(r => { o[r.key] = r.value; });
  return o;
}
export async function setSetting(key, value) {
  const { error } = await sb.from("settings")
    .upsert({ key, value: String(value), updated_at: new Date().toISOString() });
  if (error) throw error;
}

// 현재 데이터를 전부 지우고 주어진 스냅샷으로 덮어씀
async function overwriteAll(data) {
  for (const t of BACKUP_TABLES) {
    const { error: delErr } = await sb.from(t).delete().neq("id", NIL_UUID);
    if (delErr) throw delErr;
    const rows = data[t] || [];
    if (rows.length) {
      const { error: insErr } = await sb.from(t).insert(rows);
      if (insErr) throw insErr;
    }
  }
}

// DB에 저장된 백업으로 복원
export async function restoreBackup(id) {
  const { data: row, error } = await sb.from("backups").select("data").eq("id", id).single();
  if (error) throw error;
  await overwriteAll(row.data || {});
}

// 업로드한 JSON 데이터로 복원 (형식 검증 후 덮어쓰기)
export async function restoreFromData(data) {
  if (!data || typeof data !== "object") throw new Error("올바른 백업 파일이 아닙니다.");
  for (const t of BACKUP_TABLES) {
    if (!Array.isArray(data[t])) throw new Error(`올바른 백업 파일이 아닙니다. (${t} 항목 누락)`);
  }
  await overwriteAll(data);
}

// ── 폼 → 객체 ───────────────────────────────────────────────
export function formObj(form) {
  return Object.fromEntries(new FormData(form).entries());
}
