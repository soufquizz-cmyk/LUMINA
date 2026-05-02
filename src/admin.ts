import Hls from "hls.js";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { displayChannelName } from "./assignmentMatch";
import {
  type AdminCategory,
  type AdminConfig,
  type AdminCountry,
  type AdminPackage,
  EMPTY_ADMIN_CONFIG,
  leafCategoryLabel,
  readAdminConfigFromLocalStorage,
  writeAdminConfigToLocalStorage,
} from "./adminHierarchyConfig";
import {
  type LiveCategory,
  type LiveStream,
  tryNodecastLoginAndLoad,
  resolveNodecastStreamUrl,
  proxiedUrl,
  normalizeServerInput,
  sameOrigin,
} from "./nodecastCatalog";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const elServer = $("#admin-server") as HTMLInputElement;
const elUser = $("#admin-user") as HTMLInputElement;
const elPass = $("#admin-pass") as HTMLInputElement;
const elBtnConnect = $("#admin-btn-connect") as HTMLButtonElement;
const elConnectStatus = $("#admin-connect-status") as HTMLSpanElement;
const elAdminStatus = $("#admin-status") as HTMLParagraphElement;
const elFoldMeta = $("#admin-fold-meta") as HTMLSpanElement;
const elWork = $("#admin-work") as HTMLElement;
const elVideo = $("#admin-preview-video") as HTMLVideoElement;
const elPreviewStatus = $("#admin-preview-status") as HTMLParagraphElement;
const elProviderCat = $("#admin-provider-cat") as HTMLSelectElement;
const elChannelSearch = $("#admin-channel-search") as HTMLInputElement;
const elChannelPick = $("#admin-channel-pick") as HTMLSelectElement;
const elChannelCategory = $("#admin-channel-category") as HTMLSelectElement;
const elAssignmentName = $("#admin-assignment-name") as HTMLInputElement;

const elCountryName = $("#admin-country-name") as HTMLInputElement;
const elAddCountry = $("#admin-add-country") as HTMLButtonElement;
const elCountryList = $("#admin-country-list") as HTMLUListElement;
const elPkgCountry = $("#admin-pkg-country") as HTMLSelectElement;
const elPackageName = $("#admin-package-name") as HTMLInputElement;
const elAddPackage = $("#admin-add-package") as HTMLButtonElement;
const elPackageList = $("#admin-package-list") as HTMLUListElement;
const elCatCountry = $("#admin-cat-country") as HTMLSelectElement;
const elCatPackage = $("#admin-cat-package") as HTMLSelectElement;
const elLeafCategoryName = $("#admin-leaf-category-name") as HTMLInputElement;
const elAddLeafCategory = $("#admin-add-leaf-category") as HTMLButtonElement;
const elLeafCategoryList = $("#admin-leaf-category-list") as HTMLUListElement;

const elAddAssignment = $("#admin-add-assignment") as HTMLButtonElement;
const elCancelAssignmentEdit = $("#admin-cancel-assignment-edit") as HTMLButtonElement;
const elAssignmentList = $("#admin-assignment-list") as HTMLUListElement;
const elHiddenMatch = $("#admin-hidden-match") as HTMLInputElement;
const elAddFilter = $("#admin-add-filter") as HTMLButtonElement;
const elFilterList = $("#admin-filter-list") as HTMLUListElement;

elServer.value = "http://5.180.180.198:3000";
elUser.value = "samadoxal";
elPass.value = "123456";

let adminConfig: AdminConfig = { ...EMPTY_ADMIN_CONFIG };
let channelSearch = "";

const supabaseUrl = import.meta.env.NEXT_PUBLIC_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env
  .NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY as string | undefined;
const supabase: SupabaseClient | null =
  supabaseUrl && supabaseAnonKey ? createClient(supabaseUrl, supabaseAnonKey) : null;

let nodecastBase = "";
let nodecastAuth: Record<string, string> | undefined;
let catalogStreams: LiveStream[] = [];
let providerCategoryOptions: LiveCategory[] = [];
let selectedProviderCategoryId = "";
let hls: Hls | null = null;
let previewDebounceTimer: number | undefined;
let editingAssignmentId: string | null = null;

const ASSIGN_BTN_LABEL = "Assign to category";
const ASSIGN_BTN_SAVE = "Save changes";

function schedulePreviewSelected(): void {
  window.clearTimeout(previewDebounceTimer);
  previewDebounceTimer = window.setTimeout(() => {
    previewDebounceTimer = undefined;
    void previewSelected();
  }, 280);
}

function nextLocalId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function allStreamsDeduped(streamsByCat: Map<string, LiveStream[]>): LiveStream[] {
  const seen = new Map<number, LiveStream>();
  for (const list of streamsByCat.values()) {
    for (const s of list) {
      if (!seen.has(s.stream_id)) seen.set(s.stream_id, s);
    }
  }
  return [...seen.values()];
}

function buildProviderCategoryOptions(
  apiCategories: LiveCategory[],
  streams: LiveStream[]
): LiveCategory[] {
  const m = new Map<string, LiveCategory>();
  for (const c of apiCategories) {
    const id = String(c.category_id);
    if (id) m.set(id, c);
  }
  for (const s of streams) {
    const id = String(s.category_id ?? "");
    if (!id) continue;
    if (!m.has(id)) {
      m.set(id, {
        category_id: id,
        category_name: id === "uncategorized" ? "Other" : id,
        parent_id: 0,
      });
    }
  }
  return [...m.values()].sort((a, b) =>
    a.category_name.localeCompare(b.category_name, undefined, { sensitivity: "base" })
  );
}

function setConnectStatus(msg: string, isError = false): void {
  elConnectStatus.textContent = msg;
  elConnectStatus.classList.toggle("error", isError);
}

function adminStatus(msg: string, isError = false): void {
  elAdminStatus.textContent = msg;
  elAdminStatus.classList.toggle("error", isError);
}

function loadAdminFromLocalStorage(): void {
  adminConfig = readAdminConfigFromLocalStorage();
}

async function loadAdminConfig(): Promise<void> {
  if (!supabase) {
    loadAdminFromLocalStorage();
    adminStatus("Using local storage (set NEXT_PUBLIC_SUPABASE_* for shared DB).");
    return;
  }
  try {
    const [ctryRes, pkgRes, catRes, rulesRes, filtersRes] = await Promise.all([
      supabase.from("admin_countries").select("id,name").order("name", { ascending: true }),
      supabase
        .from("admin_packages")
        .select("id,country_id,name")
        .order("name", { ascending: true }),
      supabase
        .from("admin_categories")
        .select("id,package_id,name")
        .order("name", { ascending: true }),
      supabase
        .from("admin_channel_rules")
        .select("id,match_text,category_id")
        .order("created_at", { ascending: true }),
      supabase
        .from("admin_hidden_filters")
        .select("id,needle")
        .order("created_at", { ascending: true }),
    ]);
    if (
      ctryRes.error ||
      pkgRes.error ||
      catRes.error ||
      rulesRes.error ||
      filtersRes.error
    ) {
      throw (
        ctryRes.error ||
        pkgRes.error ||
        catRes.error ||
        rulesRes.error ||
        filtersRes.error
      );
    }
    adminConfig = {
      countries: (ctryRes.data ?? []) as AdminCountry[],
      packages: (pkgRes.data ?? []) as AdminPackage[],
      categories: (catRes.data ?? []) as AdminCategory[],
      assignments: (rulesRes.data ?? []) as AdminConfig["assignments"],
      hiddenFilters: (filtersRes.data ?? []) as AdminConfig["hiddenFilters"],
    };
    adminStatus("Admin config loaded from Supabase.");
  } catch (e) {
    loadAdminFromLocalStorage();
    adminStatus(
      `Supabase load failed; using local backup. ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`,
      true
    );
  }
}

function localCascadeDeleteCountry(countryId: string): void {
  const pkgIds = new Set(
    adminConfig.packages.filter((p) => p.country_id === countryId).map((p) => p.id)
  );
  const catIds = new Set(
    adminConfig.categories.filter((c) => pkgIds.has(c.package_id)).map((c) => c.id)
  );
  adminConfig.countries = adminConfig.countries.filter((c) => c.id !== countryId);
  adminConfig.packages = adminConfig.packages.filter((p) => !pkgIds.has(p.id));
  adminConfig.categories = adminConfig.categories.filter((c) => !catIds.has(c.id));
  adminConfig.assignments = adminConfig.assignments.filter((a) => !catIds.has(a.category_id));
}

function localCascadeDeletePackage(packageId: string): void {
  const catIds = new Set(
    adminConfig.categories.filter((c) => c.package_id === packageId).map((c) => c.id)
  );
  adminConfig.packages = adminConfig.packages.filter((p) => p.id !== packageId);
  adminConfig.categories = adminConfig.categories.filter((c) => !catIds.has(c.id));
  adminConfig.assignments = adminConfig.assignments.filter((a) => !catIds.has(a.category_id));
}

function localCascadeDeleteCategory(categoryId: string): void {
  adminConfig.categories = adminConfig.categories.filter((c) => c.id !== categoryId);
  adminConfig.assignments = adminConfig.assignments.filter((a) => a.category_id !== categoryId);
}

function fillCountrySelects(): void {
  const sorted = [...adminConfig.countries].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );
  const prevPkg = elPkgCountry.value;
  const prevCat = elCatCountry.value;
  const build = (sel: HTMLSelectElement, prev: string) => {
    sel.innerHTML = "";
    for (const c of sorted) {
      const o = document.createElement("option");
      o.value = c.id;
      o.textContent = c.name;
      sel.appendChild(o);
    }
    if (prev && [...sel.options].some((opt) => opt.value === prev)) sel.value = prev;
    else if (sorted.length) sel.value = sorted[0].id;
  };
  build(elPkgCountry, prevPkg);
  build(elCatCountry, prevCat);
}

function fillCatPackageSelect(): void {
  const countryId = elCatCountry.value;
  const prev = elCatPackage.value;
  const pkgs = [...adminConfig.packages]
    .filter((p) => p.country_id === countryId)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  elCatPackage.innerHTML = "";
  for (const p of pkgs) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.name;
    elCatPackage.appendChild(o);
  }
  if (prev && [...elCatPackage.options].some((opt) => opt.value === prev)) elCatPackage.value = prev;
  else if (pkgs.length) elCatPackage.value = pkgs[0].id;
}

function destroyPreview(): void {
  if (hls) {
    hls.destroy();
    hls = null;
  }
  elVideo.removeAttribute("src");
  elVideo.load();
}

function playPreview(url: string, label: string): void {
  destroyPreview();
  const proxied = proxiedUrl(url);
  elPreviewStatus.textContent = label;
  if (elVideo.canPlayType("application/vnd.apple.mpegurl")) {
    elVideo.src = proxied;
    void elVideo.play().catch(() => {});
    return;
  }
  if (Hls.isSupported()) {
    hls = new Hls({ enableWorker: true, lowLatencyMode: false });
    hls.loadSource(proxied);
    hls.attachMedia(elVideo);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      void elVideo.play().catch(() => {});
    });
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (data.fatal) {
        elPreviewStatus.textContent = `Playback error: ${data.type}`;
      }
    });
    return;
  }
  elPreviewStatus.textContent = "HLS not supported in this browser.";
}

function streamsMatchingProviderFilter(streams: LiveStream[]): LiveStream[] {
  if (!selectedProviderCategoryId) return streams;
  return streams.filter((s) => String(s.category_id ?? "") === selectedProviderCategoryId);
}

function renderProviderCategorySelect(): void {
  const prev = elProviderCat.value;
  elProviderCat.innerHTML = "";
  const allOpt = document.createElement("option");
  allOpt.value = "";
  allOpt.textContent = "All catalogue packages";
  elProviderCat.appendChild(allOpt);
  for (const c of providerCategoryOptions) {
    const id = String(c.category_id);
    const o = document.createElement("option");
    o.value = id;
    const n = c.category_name.trim() || id;
    const count = catalogStreams.filter((s) => String(s.category_id ?? "") === id).length;
    o.textContent = count ? `${n} (${count})` : n;
    elProviderCat.appendChild(o);
  }
  if (prev && [...elProviderCat.options].some((opt) => opt.value === prev)) {
    elProviderCat.value = prev;
    selectedProviderCategoryId = prev;
  } else {
    elProviderCat.value = "";
    selectedProviderCategoryId = "";
  }
}

function renderChannelPicker(): void {
  const inCat = streamsMatchingProviderFilter(catalogStreams);
  const q = channelSearch.trim().toLowerCase();
  const filtered = q
    ? inCat.filter((s) => s.name.toLowerCase().includes(q))
    : inCat;
  const limited = filtered.slice(0, 1500);
  const prev = elChannelPick.value;
  elChannelPick.innerHTML = "";
  for (const s of limited) {
    const o = document.createElement("option");
    o.value = String(s.stream_id);
    o.textContent = displayChannelName(s.name);
    elChannelPick.appendChild(o);
  }
  if (prev && limited.some((s) => String(s.stream_id) === prev)) {
    elChannelPick.value = prev;
  }
}

function selectedCatalogStream(): LiveStream | null {
  const id = elChannelPick.value;
  if (!id) return null;
  return catalogStreams.find((s) => String(s.stream_id) === id) ?? null;
}

function syncAssignmentNameFromChannelPick(): void {
  const s = selectedCatalogStream();
  elAssignmentName.value = s ? s.name : "";
}

function renderAssignCategorySelect(forceCategoryId?: string): void {
  const prevCategoryId = elChannelCategory.value;
  elChannelCategory.innerHTML = "";
  const sortedCountries = [...adminConfig.countries].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );
  const validIds = new Set<string>();
  for (const cy of sortedCountries) {
    const pkgs = [...adminConfig.packages]
      .filter((p) => p.country_id === cy.id)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    for (const pkg of pkgs) {
      const cats = [...adminConfig.categories]
        .filter((c) => c.package_id === pkg.id)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      if (!cats.length) continue;
      const og = document.createElement("optgroup");
      og.label = `${cy.name} › ${pkg.name}`;
      for (const cat of cats) {
        validIds.add(cat.id);
        const o = document.createElement("option");
        o.value = cat.id;
        o.textContent = cat.name;
        og.appendChild(o);
      }
      elChannelCategory.appendChild(og);
    }
  }
  const forced =
    forceCategoryId !== undefined &&
    forceCategoryId !== "" &&
    validIds.has(forceCategoryId)
      ? forceCategoryId
      : "";
  const prev = prevCategoryId && validIds.has(prevCategoryId) ? prevCategoryId : "";
  const pick = forced || prev;
  if (pick) elChannelCategory.value = pick;
}

function clearAssignmentEdit(): void {
  editingAssignmentId = null;
  elAddAssignment.textContent = ASSIGN_BTN_LABEL;
  elCancelAssignmentEdit.classList.add("hidden");
}

function beginEditAssignment(a: AdminConfig["assignments"][0]): void {
  editingAssignmentId = a.id;
  elAssignmentName.value = a.match_text;
  renderAssignCategorySelect(a.category_id);
  elAddAssignment.textContent = ASSIGN_BTN_SAVE;
  elCancelAssignmentEdit.classList.remove("hidden");
  renderAssignmentList();
  elAssignmentName.focus();
  elAssignmentName.select();
}

function renderAssignmentList(): void {
  elAssignmentList.innerHTML = "";
  for (const a of adminConfig.assignments) {
    const li = document.createElement("li");
    if (a.id === editingAssignmentId) li.classList.add("admin-list-item--editing");
    const label = document.createElement("span");
    label.className = "admin-list-item__label";
    label.textContent = `"${displayChannelName(a.match_text)}" → ${leafCategoryLabel(adminConfig, a.category_id)}`;
    const actions = document.createElement("span");
    actions.className = "admin-list-item__actions";
    const btnEdit = document.createElement("button");
    btnEdit.type = "button";
    btnEdit.textContent = "Edit";
    btnEdit.addEventListener("click", () => {
      beginEditAssignment(a);
    });
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Delete";
    btn.addEventListener("click", () => {
      void (async () => {
        try {
          await deleteAdminAssignment(a.id);
          renderAdminLists();
          adminStatus("Assignment deleted.");
        } catch (e) {
          adminStatus(e instanceof Error ? e.message : String(e), true);
        }
      })();
    });
    actions.appendChild(btnEdit);
    actions.appendChild(btn);
    li.appendChild(label);
    li.appendChild(actions);
    elAssignmentList.appendChild(li);
  }
}

function renderCountryList(): void {
  elCountryList.innerHTML = "";
  const sorted = [...adminConfig.countries].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );
  for (const c of sorted) {
    const li = document.createElement("li");
    li.textContent = c.name;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Delete";
    btn.addEventListener("click", () => {
      void (async () => {
        try {
          await deleteCountry(c.id);
          renderAdminLists();
          adminStatus("Country deleted.");
        } catch (e) {
          adminStatus(e instanceof Error ? e.message : String(e), true);
        }
      })();
    });
    li.appendChild(btn);
    elCountryList.appendChild(li);
  }
}

function renderPackageList(): void {
  elPackageList.innerHTML = "";
  const cid = elPkgCountry.value;
  const pkgs = [...adminConfig.packages]
    .filter((p) => p.country_id === cid)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  for (const p of pkgs) {
    const li = document.createElement("li");
    li.textContent = p.name;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Delete";
    btn.addEventListener("click", () => {
      void (async () => {
        try {
          await deletePackage(p.id);
          renderAdminLists();
          adminStatus("Package deleted.");
        } catch (e) {
          adminStatus(e instanceof Error ? e.message : String(e), true);
        }
      })();
    });
    li.appendChild(btn);
    elPackageList.appendChild(li);
  }
}

function renderLeafCategoryList(): void {
  elLeafCategoryList.innerHTML = "";
  const pid = elCatPackage.value;
  if (!pid) return;
  const cats = [...adminConfig.categories]
    .filter((c) => c.package_id === pid)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  for (const c of cats) {
    const li = document.createElement("li");
    li.textContent = c.name;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Delete";
    btn.addEventListener("click", () => {
      void (async () => {
        try {
          await deleteLeafCategory(c.id);
          renderAdminLists();
          adminStatus("Category deleted.");
        } catch (e) {
          adminStatus(e instanceof Error ? e.message : String(e), true);
        }
      })();
    });
    li.appendChild(btn);
    elLeafCategoryList.appendChild(li);
  }
}

function renderAdminLists(): void {
  fillCountrySelects();
  fillCatPackageSelect();
  renderCountryList();
  renderPackageList();
  renderLeafCategoryList();
  renderAssignCategorySelect();
  renderProviderCategorySelect();
  renderChannelPicker();

  renderAssignmentList();

  elFilterList.innerHTML = "";
  for (const f of adminConfig.hiddenFilters) {
    const li = document.createElement("li");
    li.textContent = f.needle;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Delete";
    btn.addEventListener("click", () => {
      void (async () => {
        try {
          await deleteAdminFilter(f.id);
          renderAdminLists();
          adminStatus("Hidden filter deleted.");
        } catch (e) {
          adminStatus(e instanceof Error ? e.message : String(e), true);
        }
      })();
    });
    li.appendChild(btn);
    elFilterList.appendChild(li);
  }
}

async function addCountry(name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  if (supabase) {
    const { data, error } = await supabase
      .from("admin_countries")
      .insert({ name: trimmed })
      .select("id,name")
      .single();
    if (error) throw error;
    adminConfig.countries.push(data as AdminCountry);
  } else {
    adminConfig.countries.push({ id: nextLocalId("country"), name: trimmed });
    writeAdminConfigToLocalStorage(adminConfig);
  }
}

async function deleteCountry(id: string): Promise<void> {
  if (supabase) {
    const { error } = await supabase.from("admin_countries").delete().eq("id", id);
    if (error) throw error;
  }
  localCascadeDeleteCountry(id);
  if (!supabase) writeAdminConfigToLocalStorage(adminConfig);
}

async function addPackage(countryId: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed || !countryId) return;
  if (supabase) {
    const { data, error } = await supabase
      .from("admin_packages")
      .insert({ country_id: countryId, name: trimmed })
      .select("id,country_id,name")
      .single();
    if (error) throw error;
    adminConfig.packages.push(data as AdminPackage);
  } else {
    adminConfig.packages.push({
      id: nextLocalId("pkg"),
      country_id: countryId,
      name: trimmed,
    });
    writeAdminConfigToLocalStorage(adminConfig);
  }
}

async function deletePackage(id: string): Promise<void> {
  if (supabase) {
    const { error } = await supabase.from("admin_packages").delete().eq("id", id);
    if (error) throw error;
  }
  localCascadeDeletePackage(id);
  if (!supabase) writeAdminConfigToLocalStorage(adminConfig);
}

async function addLeafCategory(packageId: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed || !packageId) return;
  if (supabase) {
    const { data, error } = await supabase
      .from("admin_categories")
      .insert({ package_id: packageId, name: trimmed })
      .select("id,package_id,name")
      .single();
    if (error) throw error;
    adminConfig.categories.push(data as AdminCategory);
  } else {
    adminConfig.categories.push({
      id: nextLocalId("leaf"),
      package_id: packageId,
      name: trimmed,
    });
    writeAdminConfigToLocalStorage(adminConfig);
  }
}

async function deleteLeafCategory(id: string): Promise<void> {
  if (supabase) {
    const { error } = await supabase.from("admin_categories").delete().eq("id", id);
    if (error) throw error;
  }
  localCascadeDeleteCategory(id);
  if (!supabase) writeAdminConfigToLocalStorage(adminConfig);
}

async function addAdminAssignment(matchText: string, categoryId: string): Promise<void> {
  const trimmed = matchText.trim();
  if (!trimmed || !categoryId) return;
  if (supabase) {
    const { data, error } = await supabase
      .from("admin_channel_rules")
      .insert({ match_text: trimmed, category_id: categoryId })
      .select("id,match_text,category_id")
      .single();
    if (error) throw error;
    adminConfig.assignments.push(data as AdminConfig["assignments"][0]);
  } else {
    adminConfig.assignments.push({
      id: nextLocalId("rule"),
      match_text: trimmed,
      category_id: categoryId,
    });
    writeAdminConfigToLocalStorage(adminConfig);
  }
}

async function updateAdminAssignment(
  id: string,
  matchText: string,
  categoryId: string
): Promise<void> {
  const trimmed = matchText.trim();
  if (!trimmed || !categoryId) return;
  if (supabase) {
    const { data, error } = await supabase
      .from("admin_channel_rules")
      .update({ match_text: trimmed, category_id: categoryId })
      .eq("id", id)
      .select("id,match_text,category_id")
      .single();
    if (error) throw error;
    const idx = adminConfig.assignments.findIndex((a) => a.id === id);
    if (idx >= 0) adminConfig.assignments[idx] = data as AdminConfig["assignments"][0];
  } else {
    const idx = adminConfig.assignments.findIndex((a) => a.id === id);
    if (idx >= 0) {
      adminConfig.assignments[idx] = {
        id,
        match_text: trimmed,
        category_id: categoryId,
      };
    }
    writeAdminConfigToLocalStorage(adminConfig);
  }
}

async function deleteAdminAssignment(id: string): Promise<void> {
  if (editingAssignmentId === id) clearAssignmentEdit();
  if (supabase) {
    const { error } = await supabase.from("admin_channel_rules").delete().eq("id", id);
    if (error) throw error;
  }
  adminConfig.assignments = adminConfig.assignments.filter((a) => a.id !== id);
  if (!supabase) writeAdminConfigToLocalStorage(adminConfig);
}

async function addAdminFilter(needle: string): Promise<void> {
  const trimmed = needle.trim();
  if (!trimmed) return;
  if (supabase) {
    const { data, error } = await supabase
      .from("admin_hidden_filters")
      .insert({ needle: trimmed })
      .select("id,needle")
      .single();
    if (error) throw error;
    adminConfig.hiddenFilters.push(data as AdminConfig["hiddenFilters"][0]);
  } else {
    adminConfig.hiddenFilters.push({ id: nextLocalId("filter"), needle: trimmed });
    writeAdminConfigToLocalStorage(adminConfig);
  }
}

async function deleteAdminFilter(id: string): Promise<void> {
  if (supabase) {
    const { error } = await supabase.from("admin_hidden_filters").delete().eq("id", id);
    if (error) throw error;
  }
  adminConfig.hiddenFilters = adminConfig.hiddenFilters.filter((f) => f.id !== id);
  if (!supabase) writeAdminConfigToLocalStorage(adminConfig);
}

async function connectCatalogue(): Promise<void> {
  setConnectStatus("");
  const base = normalizeServerInput(elServer.value);
  const username = elUser.value.trim();
  const password = elPass.value;
  if (!base || !username || !password) {
    setConnectStatus("Fill URL, username, and password.", true);
    return;
  }
  elBtnConnect.disabled = true;
  setConnectStatus("Loading catalogue…");
  try {
    const nodecast = await tryNodecastLoginAndLoad(base, username, password);
    nodecastBase = base;
    nodecastAuth = nodecast.authHeaders;
    catalogStreams = allStreamsDeduped(nodecast.streamsByCat);
    providerCategoryOptions = buildProviderCategoryOptions(
      nodecast.categories,
      catalogStreams
    );
    selectedProviderCategoryId = "";
    elProviderCat.value = "";
    elWork.classList.remove("hidden");
    const meta = `${catalogStreams.length} channels · ${providerCategoryOptions.length} catalogue packages`;
    setConnectStatus(meta);
    elFoldMeta.textContent = meta;
    renderAdminLists();
  } catch (e) {
    setConnectStatus(e instanceof Error ? e.message : String(e), true);
    elFoldMeta.textContent = "";
    elWork.classList.add("hidden");
    catalogStreams = [];
  } finally {
    elBtnConnect.disabled = false;
  }
}

async function previewSelected(): Promise<void> {
  const s = selectedCatalogStream();
  if (!s || !nodecastBase) {
    elPreviewStatus.textContent = "Select a channel first.";
    return;
  }
  elPreviewStatus.textContent = "Resolving…";
  const resolved = await resolveNodecastStreamUrl(nodecastBase, s, nodecastAuth);
  if (!resolved) {
    elPreviewStatus.textContent = "Could not resolve stream URL.";
    return;
  }
  if (!sameOrigin(resolved, nodecastBase)) {
    elPreviewStatus.textContent = "Blocked: URL is not on the Nodecast origin.";
    return;
  }
  playPreview(resolved, displayChannelName(s.name));
}

elBtnConnect.addEventListener("click", () => void connectCatalogue());

elProviderCat.addEventListener("change", () => {
  selectedProviderCategoryId = elProviderCat.value;
  renderChannelPicker();
});

elChannelSearch.addEventListener("input", () => {
  channelSearch = elChannelSearch.value;
  renderChannelPicker();
});

elChannelPick.addEventListener("change", () => {
  if (!editingAssignmentId) syncAssignmentNameFromChannelPick();
  schedulePreviewSelected();
});

elPkgCountry.addEventListener("change", () => {
  renderPackageList();
});

elCatCountry.addEventListener("change", () => {
  fillCatPackageSelect();
  renderLeafCategoryList();
});

elCatPackage.addEventListener("change", () => {
  renderLeafCategoryList();
});

elAddCountry.addEventListener("click", () => {
  void (async () => {
    try {
      await addCountry(elCountryName.value);
      elCountryName.value = "";
      renderAdminLists();
      adminStatus("Country added.");
    } catch (e) {
      adminStatus(e instanceof Error ? e.message : String(e), true);
    }
  })();
});

elAddPackage.addEventListener("click", () => {
  void (async () => {
    try {
      await addPackage(elPkgCountry.value, elPackageName.value);
      elPackageName.value = "";
      renderAdminLists();
      adminStatus("Package added.");
    } catch (e) {
      adminStatus(e instanceof Error ? e.message : String(e), true);
    }
  })();
});

elAddLeafCategory.addEventListener("click", () => {
  void (async () => {
    try {
      await addLeafCategory(elCatPackage.value, elLeafCategoryName.value);
      elLeafCategoryName.value = "";
      renderAdminLists();
      adminStatus("Category added.");
    } catch (e) {
      adminStatus(e instanceof Error ? e.message : String(e), true);
    }
  })();
});

elAddAssignment.addEventListener("click", () => {
  void (async () => {
    const matchText = elAssignmentName.value.trim();
    if (!matchText) {
      adminStatus("Enter a match name or pick a channel from the list.", true);
      return;
    }
    if (!elChannelCategory.value) {
      adminStatus("Add a country, package, and category first.", true);
      return;
    }
    try {
      if (editingAssignmentId) {
        await updateAdminAssignment(editingAssignmentId, matchText, elChannelCategory.value);
        clearAssignmentEdit();
        renderAdminLists();
        adminStatus(`Updated: ${displayChannelName(matchText)}`);
      } else {
        await addAdminAssignment(matchText, elChannelCategory.value);
        renderAdminLists();
        adminStatus(`Assigned: ${displayChannelName(matchText)}`);
      }
    } catch (e) {
      adminStatus(e instanceof Error ? e.message : String(e), true);
    }
  })();
});

elCancelAssignmentEdit.addEventListener("click", () => {
  clearAssignmentEdit();
  syncAssignmentNameFromChannelPick();
  renderAdminLists();
});

elAddFilter.addEventListener("click", () => {
  void (async () => {
    try {
      await addAdminFilter(elHiddenMatch.value);
      elHiddenMatch.value = "";
      renderAdminLists();
      adminStatus("Hidden filter added.");
    } catch (e) {
      adminStatus(e instanceof Error ? e.message : String(e), true);
    }
  })();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && document.activeElement?.closest(".admin-standalone__connect")) {
    void connectCatalogue();
  }
});

void (async () => {
  await loadAdminConfig();
  renderAdminLists();
})();
