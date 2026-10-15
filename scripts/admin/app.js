let importPlan = null;
const $ = (selector) => document.querySelector(selector);
import {
  translateAdmin,
  preferredLanguage,
  countryHint,
} from "/admin-i18n.mjs";
let manual = null;
try {
  manual = localStorage.getItem("pvca-language");
} catch {}
let lang = preferredLanguage(
  manual,
  navigator.languages,
  countryHint(
    navigator.language,
    Intl.DateTimeFormat().resolvedOptions().timeZone
  )
);
const t = (text) => translateAdmin(lang, text);
const originalText = new WeakMap(),
  originalAttributes = new WeakMap();
function translateDocument() {
  document.documentElement.lang = lang;
  document.title = t("Painel local") + " — Acervo PVCA";
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (["SCRIPT", "STYLE", "TEXTAREA"].includes(node.parentElement?.tagName))
      continue;
    if (!originalText.has(node)) originalText.set(node, node.textContent);
    const value = originalText.get(node);
    node.textContent = value.replace(value.trim(), t(value.trim()));
  }
  for (const element of document.querySelectorAll(
    "[aria-label],[placeholder]"
  )) {
    if (!originalAttributes.has(element))
      originalAttributes.set(element, {
        label: element.getAttribute("aria-label"),
        placeholder: element.getAttribute("placeholder"),
      });
    const values = originalAttributes.get(element);
    if (values.label) element.setAttribute("aria-label", t(values.label));
    if (values.placeholder)
      element.setAttribute("placeholder", t(values.placeholder));
  }
}
$("#admin-language").value = lang;
let state, currentFilm, currentSelectionId;
let filmLimit = 48;
let selectedOnly = false;
let activeSection = "films";
const dirtyForms = new Set();
const copyData = new WeakMap();
const normalize = (text) =>
  String(text ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase();
const digest = async (text) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const status = (message) => {
  $("#status").textContent = t(message);
  $("#status").classList.toggle("has-message", Boolean(message));
};
const list = (value) =>
  (value ?? "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
const element = (tag, text) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = t(text);
  return node;
};
function option(select, value, label) {
  const node = element("option", label);
  node.value = value;
  select.append(node);
}
async function api(route, value) {
  const revisionHeaders = {};
  if (route === "editorial")
    revisionHeaders["X-PVCA-Editorial"] = state.editorialVersion;
  if (route === "apply" && currentFilm?.id)
    revisionHeaders["X-PVCA-Record"] = await digest(
      JSON.stringify(
        state.catalog.find((film) => film.id === currentFilm.id) ?? currentFilm
      )
    );
  const response = await fetch("/api/" + route, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-PVCA-Token": state.token,
      ...revisionHeaders,
    },
    body: JSON.stringify(value),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error);
  return result;
}
async function action(work) {
  const controls = [
    ...document.querySelectorAll("button, input, textarea, select"),
  ];
  const disabled = new Map(
    controls.map((control) => [control, control.disabled])
  );
  for (const control of controls) control.disabled = true;
  document.body.setAttribute("aria-busy", "true");
  try {
    await work();
  } catch (error) {
    status(error.message);
    $("#status").focus();
  } finally {
    for (const [control, value] of disabled)
      if (control.isConnected) control.disabled = value;
    document.body.removeAttribute("aria-busy");
    syncControls();
  }
}
function syncControls() {
  $("#import-confirm").disabled = !importPlan;
  $("#delete-film").disabled = !currentFilm?.id;
  $("#remove-selection").disabled = !currentSelectionId;
  for (const input of $("#selection-films").querySelectorAll("input"))
    input.disabled = $("#selection-form").elements.rule.value !== "manual";
}
function markDirty(formId, value = true) {
  if (value) dirtyForms.add(formId);
  else dirtyForms.delete(formId);
  for (const [id, target] of [
    ["film-form", "film-dirty"],
    ["selection-form", "selection-dirty"],
  ])
    $("#" + target).textContent = t(
      dirtyForms.has(id) ? "Alterações não salvas" : "Sem alterações pendentes"
    );
}
function confirmAction(title, description, label) {
  const dialog = $("#confirm-dialog");
  $("#confirm-title").textContent = title;
  $("#confirm-description").textContent = description;
  $("#confirm-accept").textContent = t(label);
  return new Promise((resolve) => {
    dialog.addEventListener(
      "close",
      () => resolve(dialog.returnValue === "confirm"),
      { once: true }
    );
    dialog.returnValue = "cancel";
    dialog.showModal();
  });
}
async function canLeave(formId) {
  const affected = formId
    ? [formId].filter((id) => dirtyForms.has(id))
    : [...dirtyForms];
  if (!affected.length) return true;
  const accepted = await confirmAction(
    t("Descartar alterações?"),
    t("Há alterações não salvas. Descartá-las para continuar?"),
    "Descartar alterações"
  );
  if (accepted) for (const id of affected) markDirty(id, false);
  return accepted;
}
function field(parent, name, label, value = "", type = "text", wide = false) {
  const wrapper = element("label", label);
  if (wide) wrapper.className = "wide";
  const input = element(type === "textarea" ? "textarea" : "input");
  input.name = name;
  input.value = value ?? "";
  if (type !== "textarea") input.type = type;
  wrapper.append(input);
  parent.append(wrapper);
  return input;
}
function checkbox(parent, name, value, label, checked) {
  const wrapper = element("label");
  const input = element("input");
  input.type = "checkbox";
  input.name = name;
  input.value = value;
  input.checked = checked;
  wrapper.append(input, document.createTextNode(t(label)));
  parent.append(wrapper);
}
function populateHome() {
  const form = $("#home-form");
  form.elements.featuredSlug.value = state.editorial.featuredSlug ?? "";
  $("#featured-search").value = "";
  renderFeaturedCurrent();
  renderFeaturedResults();
  form.elements.featuredNote.value = state.editorial.featuredNote ?? "";
  form.elements.featuredNoteEn.value = state.editorial.featuredNotes?.en ?? "";
  form.elements.recentLimit.value = state.editorial.recentLimit;
  form.elements.showStats.checked = state.editorial.showStats;
  const parent = $("#home-selections");
  parent.replaceChildren(element("legend", "Seleções na home"));
  for (const selection of state.editorial.selections)
    checkbox(
      parent,
      "homeSelectionIds",
      selection.id,
      selection.title,
      state.editorial.homeSelectionIds.includes(selection.id)
    );
}
async function load() {
  const response = await fetch("/api/state");
  state = await response.json();
  $("#preview-note").textContent = state.preview
    ? "O catálogo real está vazio. O site usa os exemplos da prévia; eles não são filmes importados."
    : "";
  populateHome();
  renderGallery();
  renderSelections();
  syncControls();
  translateDocument();
}
const slugify = (value) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
function editFilm(film) {
  currentFilm = structuredClone(
    film ?? {
      id: "",
      slug: "",
      title: "",
      year: null,
      directors: [],
      countries: [],
      poster: "",
      catalog_copy_id: "copy-1",
      copies: [
        {
          id: "copy-1",
          resolution: "",
          size_gib: null,
          audio_languages: [],
          subtitle_languages: [],
        },
      ],
      external_links: [],
      selections: [],
      added_at: new Date().toISOString().slice(0, 10),
    }
  );
  $("#film-editor").hidden = false;
  $("#editor-title").textContent = film?.title || t("Nova ficha");
  $("#film-state").textContent = t(
    film && state.catalog.some((item) => item.id === film.id)
      ? "Catálogo local"
      : "Rascunho"
  );
  $("#editor-poster").hidden = !film?.poster;
  if (film?.poster) $("#editor-poster").src = film.poster;
  for (const id of ["film-fields", "advanced-fields", "text-fields"])
    $("#" + id).replaceChildren();
  showPart("identity");
  for (const [key, label, type] of [
    ["title", "Título"],
    ["tmdb_id", "TMDB ID", "number"],
    ["year", "Ano", "number"],
    ["directors", "Direção (separe nomes com ;)"],
    ["countries", "Países (separe com ;)"],
    ["slug", "Endereço da ficha"],
    ["added_at", "Data de entrada no catálogo", "date"],
    ["original_title", "Título original"],
    ["romanized_title", "Título romanizado"],
    ["runtime_minutes", "Duração em minutos", "number"],
    ["genres", "Gêneros (separe com ;)"],
    ["original_languages", "Idiomas originais (separe com ;)"],
    ["poster", "Caminho do pôster"],
    ["title_pt", "Título (pt-BR)"],
    ["title_en", "Título (en)"],
    ["synopsis_pt", "Sinopse (pt-BR)", "textarea"],
    ["synopsis_en", "Sinopse (en)", "textarea"],
    ["note_en", "Nota editorial (en)", "textarea"],
    ["synopsis", "Sinopse", "textarea"],
    ["collection_note", "Nota editorial pública", "textarea"],
  ])
    field(
      $(
        "#" +
          (["tmdb_id", "slug", "poster"].includes(key)
            ? "advanced-fields"
            : [
                  "title_pt",
                  "title_en",
                  "synopsis_pt",
                  "synopsis_en",
                  "note_en",
                  "synopsis",
                  "collection_note",
                ].includes(key)
              ? "text-fields"
              : "film-fields")
      ),
      key,
      key === "synopsis" ? "Sinopse de referência (legado)" : label,
      Array.isArray(currentFilm[key])
        ? currentFilm[key].join("; ")
        : currentFilm[key],
      type ?? "text",
      type === "textarea"
    );
  const formFields = $("#film-form").elements;
  formFields.title_pt.value =
    currentFilm.translations?.["pt-BR"]?.title ?? currentFilm.title;
  formFields.title_en.value = currentFilm.translations?.en?.title ?? "";
  formFields.synopsis_pt.value =
    currentFilm.translations?.["pt-BR"]?.synopsis ?? currentFilm.synopsis ?? "";
  formFields.synopsis_en.value = currentFilm.translations?.en?.synopsis ?? "";
  formFields.note_en.value =
    currentFilm.translations?.en?.collection_note ?? "";
  const poster = field(
    $("#text-fields"),
    "poster_file",
    "Escolher imagem do pôster",
    "",
    "file",
    true
  );
  poster.accept = "image/png,image/jpeg,image/webp,image/avif";
  poster.addEventListener("change", () =>
    action(async () => {
      const file = poster.files[0];
      if (!file) return;
      const extension = file.name.split(".").pop().toLowerCase();
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      const result = await api("poster", { extension, base64: btoa(binary) });
      $("#film-form").elements.poster.value = result.poster;
      markDirty("film-form");
      $("#editor-poster").src = result.poster;
      $("#editor-poster").hidden = false;
      status("Pôster guardado localmente. Salve o filme para associá-lo.");
    })
  );
  if (!film) {
    const form = $("#film-form");
    const generate = () => {
      form.elements.slug.value = slugify(
        form.elements.title.value + "-" + form.elements.year.value
      );
    };
    form.elements.title.addEventListener("input", generate);
    form.elements.year.addEventListener("input", generate);
  } else $("#film-form").elements.slug.readOnly = true;
  $("#copies").replaceChildren();
  for (const copy of currentFilm.copies) addCopy(copy);
  $("#links").replaceChildren();
  for (const link of currentFilm.external_links) addLink(link);
  markDirty("film-form", false);
  syncControls();
  renderGallery();
  $("#film-editor").scrollIntoView({ block: "start" });
  $("#editor-title").focus({ preventScroll: true });
}
function addCopy(
  copy = {
    id: "copy-" + crypto.randomUUID().slice(0, 8),
    resolution: "",
    size_gib: null,
    audio_languages: [],
    subtitle_languages: [],
  }
) {
  const parent = element("fieldset");
  parent.dataset.copy = "true";
  copyData.set(parent, structuredClone(copy));
  parent.append(element("legend", "Cópia preservada"));
  const fields = element("div");
  fields.className = "fields";
  parent.append(fields);
  for (const [key, label, type] of [
    ["id", "Identificador da cópia"],
    ["label", "Rótulo (se houver variantes)"],
    ["resolution", "Resolução (ex.: 1080p ou 2160p)"],
    ["size_gib", "Tamanho em GiB", "number"],
    ["format", "Formato"],
    ["edition", "Edição / restauração"],
    ["audio_languages", "Áudios (separe idiomas com ;)"],
    ["subtitle_languages", "Legendas (separe idiomas com ;)"],
  ]) {
    const input = field(
      fields,
      key,
      label,
      Array.isArray(copy[key]) ? copy[key].join("; ") : copy[key],
      type ?? "text"
    );
    if (key === "size_gib") {
      input.step = "any";
      input.min = "0";
    }
  }
  const label = element("label");
  const radio = element("input");
  radio.type = "radio";
  radio.name = "catalog-copy";
  radio.checked = currentFilm.catalog_copy_id === copy.id;
  label.append(
    radio,
    document.createTextNode(t("Usar esta cópia no catálogo"))
  );
  parent.append(label);
  const remove = element("button", "Remover cópia");
  remove.type = "button";
  remove.addEventListener("click", () => {
    parent.remove();
    markDirty("film-form");
  });
  parent.append(remove);
  $("#copies").append(parent);
}
function addLink(
  link = { provider: "internet_archive", url: "", copy_id: null }
) {
  const parent = element("fieldset");
  parent.dataset.link = "true";
  const label = element("label", "Destino");
  const select = element("select");
  select.name = "provider";
  for (const [value, title] of [
    ["internet_archive", "Internet Archive"],
    ["google_drive", "Google Drive"],
    ["other", "Outro"],
  ])
    option(select, value, title);
  select.value = link.provider;
  label.append(select);
  parent.append(label);
  field(parent, "url", "URL compartilhada", link.url, "url");
  field(parent, "copy_id", "Identificador da cópia (opcional)", link.copy_id);
  const remove = element("button", "Remover destino");
  remove.type = "button";
  remove.addEventListener("click", () => {
    parent.remove();
    markDirty("film-form");
  });
  parent.append(remove);
  $("#links").append(parent);
}
function collectFilm() {
  if (!currentFilm) throw Error("Escolha um filme ou clique em Novo filme.");
  const result = structuredClone(currentFilm),
    form = $("#film-form");
  for (const key of ["title", "slug", "poster"])
    result[key] = form.elements[key].value.trim();
  for (const key of [
    "original_title",
    "romanized_title",
    "synopsis",
    "collection_note",
    "added_at",
  ])
    result[key] = form.elements[key].value.trim() || null;
  for (const key of ["year", "runtime_minutes"])
    result[key] = form.elements[key].value
      ? Number(form.elements[key].value)
      : null;
  for (const key of ["directors", "countries", "genres", "original_languages"])
    result[key] = list(form.elements[key].value);
  result.tmdb_id = form.elements.tmdb_id.value
    ? Number(form.elements.tmdb_id.value)
    : null;
  result.translations = {
    "pt-BR": {
      ...result.translations?.["pt-BR"],
      title: form.elements.title_pt.value.trim() || result.title,
      synopsis: form.elements.synopsis_pt.value.trim() || null,
      collection_note: result.collection_note,
    },
    en: {
      title: form.elements.title_en.value.trim() || null,
      synopsis: form.elements.synopsis_en.value.trim() || null,
      collection_note: form.elements.note_en.value.trim() || null,
    },
  };
  result.id = result.id || result.slug;
  result.catalog_copy_id = "";
  result.copies = [...document.querySelectorAll("[data-copy]")].map(
    (parent) => {
      const copy = structuredClone(copyData.get(parent) ?? {});
      for (const input of parent.querySelectorAll(".fields input"))
        copy[input.name] =
          input.name === "size_gib"
            ? input.value
              ? Number(input.value)
              : null
            : ["audio_languages", "subtitle_languages"].includes(input.name)
              ? list(input.value)
              : input.value.trim();
      if (parent.querySelector("input[type=radio]").checked)
        result.catalog_copy_id = copy.id;
      for (const key of ["label", "edition", "format"])
        copy[key] = copy[key] || null;
      return copy;
    }
  );
  result.external_links = [...document.querySelectorAll("[data-link]")]
    .map((parent) => ({
      provider: parent.querySelector("select").value,
      url: parent.querySelector("[name=url]").value.trim(),
      copy_id: parent.querySelector("[name=copy_id]").value.trim() || null,
    }))
    .filter((link) => link.url);
  return result;
}
function editSelection(selection) {
  currentSelectionId = selection?.id ?? null;
  $("#selection-editor").hidden = false;
  $("#selection-title").textContent = selection?.title || t("Nova seleção");
  const form = $("#selection-form");
  for (const key of ["id", "title", "description", "rule"])
    form.elements[key].value =
      selection?.[key] ?? (key === "rule" ? "manual" : "");
  form.elements.title_en.value = selection?.localized?.en?.title ?? "";
  form.elements.description_en.value =
    selection?.localized?.en?.description ?? "";
  const parent = $("#selection-films");
  parent.replaceChildren(element("legend", "Filmes desta seleção"));
  for (const film of state.films)
    checkbox(
      parent,
      "filmSlugs",
      film.slug,
      film.title,
      selection?.filmSlugs.includes(film.slug)
    );
  $("#selection-film-search").value = "";
  selectedOnly = false;
  $("#selected-only").setAttribute("aria-pressed", "false");
  updateRule();
  filterSelectionFilms();
  markDirty("selection-form", false);
  syncControls();
  renderSelections();
  $("#selection-title").focus();
}
function updateRule() {
  const automated = $("#selection-form").elements.rule.value !== "manual";
  for (const input of $("#selection-films").querySelectorAll("input"))
    input.disabled = automated;
  $("#manual-members").hidden = automated;
  $("#automatic-note").hidden = !automated;
}
for (const button of document.querySelectorAll("[data-tab]"))
  button.addEventListener("click", async () => {
    if (activeSection === button.dataset.tab || !(await canLeave())) return;
    activeSection = button.dataset.tab;
    // Discarded values must not reappear as if they were saved.
    $("#film-editor").hidden = true;
    currentFilm = null;
    $("#selection-editor").hidden = true;
    currentSelectionId = null;
    populateHome();
    for (const id of ["home", "films", "selections", "import"])
      $("#" + id).hidden = id !== activeSection;
    for (const tab of document.querySelectorAll("[data-tab]"))
      tab.setAttribute("aria-pressed", String(tab === button));
    status("");
    $("#" + activeSection + " h1").setAttribute("tabindex", "-1");
    $("#" + activeSection + " h1").focus();
  });
$("#home-form").addEventListener("submit", (event) => {
  event.preventDefault();
  action(async () => {
    const form = event.target;
    const config = structuredClone(state.editorial);
    config.featuredSlug = form.elements.featuredSlug.value || null;
    config.featuredNote = form.elements.featuredNote.value.trim() || null;
    config.featuredNotes = {
      "pt-BR": config.featuredNote,
      en: form.elements.featuredNoteEn.value.trim() || null,
    };
    config.recentLimit = Number(form.elements.recentLimit.value);
    config.showStats = form.elements.showStats.checked;
    config.homeSelectionIds = [
      ...$("#home-selections").querySelectorAll("input:checked"),
    ].map((input) => input.value);
    await api("editorial", config);
    markDirty("home-form", false);
    await load();
    status("Início salvo. Gere a prévia para conferir.");
  });
});
function featuredTitle(film) {
  return film.translations?.[lang]?.title || film.title;
}
function featuredContents(film) {
  const content = element("span");
  if (film.poster) {
    const image = element("img");
    image.src = film.poster;
    image.alt = "";
    content.append(image);
  }
  const text = element("span");
  text.append(
    element("strong", featuredTitle(film)),
    element(
      "small",
      [film.year, film.director || (film.directors ?? []).join(", ")]
        .filter(Boolean)
        .join(" · ")
    )
  );
  content.append(text);
  return content;
}
function renderFeaturedCurrent() {
  const slug = $("#home-form").elements.featuredSlug.value;
  const film = state.films.find((film) => film.slug === slug);
  $("#featured-current").replaceChildren(
    film ? featuredContents(film) : element("p", "Sem destaque")
  );
  $("#clear-featured").disabled = !film;
}
function chooseFeatured(slug) {
  const form = $("#home-form");
  if (form.elements.featuredSlug.value !== slug) {
    form.elements.featuredSlug.value = slug;
    form.elements.featuredNote.value = "";
    form.elements.featuredNoteEn.value = "";
    markDirty("home-form");
  }
  $("#featured-search").value = "";
  renderFeaturedCurrent();
  renderFeaturedResults();
  $("#featured-search").focus();
}
function renderFeaturedResults() {
  const query = $("#featured-search").value.trim();
  const list = $("#featured-results");
  const count = $("#featured-count");
  list.replaceChildren();
  list.hidden = count.hidden = !query;
  if (!query) return;
  const films = state.films.filter((film) => filmMatches(film, query));
  count.textContent = films.length
    ? `${Math.min(8, films.length)} / ${films.length} · ${t("Resultados. Refine a busca se precisar.")}`
    : t("Nenhum filme encontrado. Tente outro título, diretor ou ano.");
  for (const film of films.slice(0, 8)) {
    const item = element("li");
    const button = element("button");
    button.type = "button";
    button.append(featuredContents(film));
    button.addEventListener("click", () => chooseFeatured(film.slug));
    item.append(button);
    list.append(item);
  }
}
$("#featured-search").addEventListener("input", renderFeaturedResults);
$("#featured-search").addEventListener("keydown", (event) => {
  const first = $("#featured-results button");
  if (event.key === "Enter") {
    event.preventDefault();
    first?.click();
  } else if (event.key === "ArrowDown" && first) {
    event.preventDefault();
    first.focus();
  } else if (event.key === "Escape") {
    event.preventDefault();
    $("#featured-search").value = "";
    renderFeaturedResults();
  }
});
$("#clear-featured").addEventListener("click", () => chooseFeatured(""));
$("#selection-form").elements.title.addEventListener("input", (event) => {
  if (!currentSelectionId)
    $("#selection-form").elements.id.value = slugify(event.target.value);
});
$("#new-film").addEventListener("click", async () => {
  if (!(await canLeave("film-form"))) return;
  editFilm();
  status("Novo rascunho. Preencha somente informações comprovadas.");
});
$("#add-copy").addEventListener("click", () => {
  if (!currentFilm) {
    status("Crie ou escolha um filme primeiro.");
    return;
  }
  addCopy();
  markDirty("film-form");
});
$("#add-link").addEventListener("click", () => {
  addLink();
  markDirty("film-form");
});
$("#save-draft").addEventListener("click", () =>
  action(async () => {
    const film = collectFilm();
    await api("draft", film);
    markDirty("film-form", false);
    await load();
    editFilm(state.drafts.find((item) => item.id === film.id) ?? film);
    status("Rascunho salvo. O catálogo do site não foi alterado.");
  })
);
$("#film-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = $("#film-form");
  const invalid = [...form.elements].find(
    (input) => input.willValidate && !input.validity.valid
  );
  if (invalid) {
    showPart(invalid.closest("[data-film-panel]").dataset.filmPanel);
    const details = invalid.closest("details");
    if (details) details.open = true;
    invalid.reportValidity();
    return;
  }
  action(async () => {
    const film = collectFilm();
    await api("apply", film);
    markDirty("film-form", false);
    await load();
    editFilm(state.catalog.find((item) => item.id === film.id));
    status(
      "Filme aplicado ao catálogo local. Gere a prévia para revisar; nada foi publicado."
    );
  });
});
$("#new-selection").addEventListener("click", async () => {
  if (await canLeave("selection-form")) editSelection();
});
$("#selection-form").elements.rule.addEventListener("change", updateRule);
$("#selection-form").addEventListener("submit", (event) => {
  event.preventDefault();
  action(async () => {
    const form = event.target;
    const selected = {
      localized: {
        en: {
          title: form.elements.title_en.value.trim(),
          description: form.elements.description_en.value.trim(),
        },
      },
      id: form.elements.id.value.trim(),
      title: form.elements.title.value.trim(),
      description: form.elements.description.value.trim(),
      rule: form.elements.rule.value,
      filmSlugs:
        form.elements.rule.value === "manual"
          ? [...$("#selection-films").querySelectorAll("input:checked")].map(
              (input) => input.value
            )
          : [],
    };
    if (
      state.editorial.selections.some(
        (s) => s.id === selected.id && s.id !== currentSelectionId
      )
    )
      throw Error("Endereço de seleção já usado.");
    const config = structuredClone(state.editorial);
    config.selections = config.selections.filter(
      (s) => s.id !== currentSelectionId
    );
    config.selections.push(selected);
    config.homeSelectionIds = config.homeSelectionIds.map((id) =>
      id === currentSelectionId ? selected.id : id
    );
    await api("editorial", config);
    markDirty("selection-form", false);
    await load();
    editSelection(selected);
    status("Seleção salva localmente.");
  });
});
$("#remove-selection").addEventListener("click", async () => {
  if (!currentSelectionId) return;
  const selection = state.editorial.selections.find(
    (item) => item.id === currentSelectionId
  );
  if (
    !(await confirmAction(
      t("Excluir seleção") + ": " + selection.title + "?",
      t(
        "A seleção será removida do catálogo local e da página inicial. Os filmes serão preservados."
      ),
      "Excluir seleção"
    ))
  )
    return;
  action(async () => {
    const config = structuredClone(state.editorial);
    config.selections = config.selections.filter(
      (s) => s.id !== currentSelectionId
    );
    config.homeSelectionIds = config.homeSelectionIds.filter(
      (id) => id !== currentSelectionId
    );
    await api("editorial", config);
    markDirty("selection-form", false);
    currentSelectionId = null;
    $("#selection-editor").hidden = true;
    await load();
    status("Seleção removida; filmes preservados.");
  });
});
$("#build").addEventListener("click", () =>
  action(async () => {
    status("Gerando prévia…");
    const result = await api("build", {});
    status(result.message);
  })
);
$("#export-letterboxd").addEventListener("click", () =>
  action(async () => {
    status("Exportando CSV…");
    const result = await api("export/letterboxd", {});
    if (typeof result.csv !== "string" || !result.filename)
      throw Error(
        "O painel em execução é uma versão antiga. Feche o processo node do painel e abra o ícone de novo."
      );
    const link = document.createElement("a");
    link.href = URL.createObjectURL(
      new Blob([result.csv], { type: "text/csv;charset=utf-8" })
    );
    link.download = result.filename;
    link.click();
    URL.revokeObjectURL(link.href);
    status(`CSV exportado (${result.count} títulos): ${result.filename}`);
  })
);
load().catch((error) => status(error.message));

$("#admin-language").addEventListener("change", async (event) => {
  if (!(await canLeave())) {
    event.target.value = lang;
    return;
  }
  lang = event.target.value;
  try {
    localStorage.setItem("pvca-language", lang);
  } catch {}
  location.reload();
});
$("#import-file").addEventListener("change", () => {
  importPlan = null;
  $("#import-confirm").disabled = true;
  $("#import-results").replaceChildren();
});
$("#enrich-tmdb").addEventListener("change", () => {
  importPlan = null;
  $("#import-confirm").disabled = true;
});
$("#portuguese-is-brazilian").addEventListener("change", () => {
  importPlan = null;
  $("#import-confirm").disabled = true;
});
$("#import-preview").addEventListener("click", () =>
  action(async () => {
    importPlan = null;
    const file = $("#import-file").files[0];
    if (!file) throw Error("Selecione um JSON primeiro.");
    if (file.size > 32 * 1024 * 1024)
      throw Error("Importação maior que 32 MiB.");
    let records;
    try {
      records = JSON.parse(await file.text());
    } catch {
      throw Error("JSON inválido.");
    }
    status("Validando importação…");
    const result = await api("import/preview", {
      records,
      enrich: $("#enrich-tmdb").checked,
      portugueseIsBrazilian: $("#portuguese-is-brazilian").checked,
    });
    importPlan = result.planId;
    const parent = $("#import-results");
    parent.replaceChildren();
    for (const [key, count] of Object.entries(result.summary))
      parent.append(element("p", t(key) + ": " + count));
    for (const [key, count] of Object.entries(result.readiness ?? {}))
      parent.append(element("p", t(key) + ": " + count));
    for (const item of result.items) {
      const entry = element("article");
      entry.append(
        element("h3", item.title || "#" + (item.index + 1)),
        element("p", t(item.status))
      );
      if (item.status === "created" || item.status === "updated")
        entry.append(
          element(
            "p",
            item.publicReady
              ? "Pronto para o site"
              : "Rascunho — faltam dados para o site"
          )
        );
      for (const reason of item.reasons) entry.append(element("p", t(reason)));
      if (item.protected.length)
        entry.append(
          element(
            "p",
            t("Campos manuais preservados") + ": " + item.protected.join(", ")
          )
        );
      parent.append(entry);
    }
    status("");
  })
);
$("#import-confirm").addEventListener("click", () =>
  action(async () => {
    if (!importPlan) return;
    const result = await api("import/confirm", { planId: importPlan });
    importPlan = null;
    await load();
    status(result.message);
  })
);
$("#tmdb-status").addEventListener("click", () =>
  action(async () => {
    const result = await api("tmdb/status", {});
    status(
      result.available ? "TMDB disponível neste computador." : result.error
    );
  })
);
translateDocument();

function showPart(part) {
  for (const panel of document.querySelectorAll("[data-film-panel]"))
    panel.hidden = panel.dataset.filmPanel !== part;
  for (const button of document.querySelectorAll("[data-part]"))
    button.setAttribute("aria-pressed", String(button.dataset.part === part));
}
for (const button of document.querySelectorAll("[data-part]"))
  button.addEventListener("click", () => showPart(button.dataset.part));
function filmMatches(film, query) {
  return normalize(
    [
      film.title,
      film.original_title,
      film.originalTitle,
      film.director,
      film.translations?.["pt-BR"]?.title,
      film.translations?.en?.title,
      film.year,
      ...(film.directors ?? []),
    ].join(" ")
  ).includes(normalize(query));
}
function renderGallery() {
  const filter = $("#film-filter").value;
  const entries =
    filter === "deleted"
      ? (state.deletedFilms ?? []).map((film) => ({ film, source: "deleted" }))
      : [
          ...(filter === "draft"
            ? []
            : state.catalog.map((film) => ({ film, source: "catalog" }))),
          ...(filter === "catalog"
            ? []
            : state.drafts.map((film) => ({ film, source: "draft" }))),
        ];
  const matches = entries.filter(({ film }) =>
    filmMatches(film, $("#film-search").value)
  );
  $("#film-count").textContent =
    `${matches.length} / ${entries.length} · ${t(filter === "deleted" ? "Excluídas" : "Fichas")}`;
  const gallery = $("#film-gallery");
  gallery.replaceChildren();
  for (const { film, source } of matches.slice(0, filmLimit)) {
    const card = element("button");
    card.className = "poster-card";
    card.setAttribute(
      "aria-pressed",
      String(currentFilm?.id === film.id && source !== "deleted")
    );
    if (source !== "deleted" && film.poster) {
      const image = element("img");
      image.src = film.poster;
      image.alt = "";
      image.loading = "lazy";
      card.append(image);
    } else {
      const cover = element(
        "span",
        source === "deleted" ? "Restaurar ficha" : "Sem pôster"
      );
      cover.className = "poster-placeholder";
      card.append(cover);
    }
    card.append(
      element(
        "strong",
        film.translations?.[lang]?.title ||
          film.title ||
          "TMDB #" + film.tmdb_id
      ),
      element("span", String(film.year ?? ""))
    );
    if (source === "draft") card.append(element("small", "Rascunho"));
    if (source === "deleted")
      card.addEventListener("click", async () => {
        if (
          !(await confirmAction(
            t("Restaurar ficha") + ": " + film.title + "?",
            t("A ficha voltará ao catálogo local. Nada será publicado."),
            "Restaurar ficha"
          ))
        )
          return;
        action(async () => {
          await api("film/restore", { id: film.id, slug: film.slug });
          await load();
          status("Ficha restaurada no acervo local.");
        });
      });
    else
      card.addEventListener("click", async () => {
        if (await canLeave("film-form")) editFilm(film);
      });
    gallery.append(card);
  }
  if (!matches.length)
    gallery.append(
      element(
        "p",
        "Nenhuma ficha encontrada. Tente outra busca ou crie uma ficha."
      )
    );
  $("#more-films").hidden = matches.length <= filmLimit;
}
$("#film-search").addEventListener("input", () => {
  filmLimit = 48;
  renderGallery();
});
$("#film-filter").addEventListener("change", () => {
  filmLimit = 48;
  renderGallery();
});
$("#more-films").addEventListener("click", () => {
  filmLimit += 48;
  renderGallery();
});
$("#close-film").addEventListener("click", async () => {
  if (!(await canLeave("film-form"))) return;
  currentFilm = null;
  $("#film-editor").hidden = true;
  renderGallery();
  $("#film-search").focus();
});
$("#delete-film").addEventListener("click", async () => {
  if (!currentFilm?.id) return;
  const expected =
    state.catalog.find((film) => film.id === currentFilm.id) ??
    state.drafts.find((film) => film.id === currentFilm.id);
  if (
    !(await confirmAction(
      t("Excluir ficha") +
        ": " +
        currentFilm.title +
        " (" +
        (currentFilm.year ?? "") +
        ")?",
      t(
        "A ficha sairá do catálogo, das seleções e do destaque locais. Edições não salvas serão descartadas. Os vídeos e pôsteres serão preservados. Recupere a ficha em Excluídas."
      ),
      "Excluir ficha"
    ))
  )
    return;
  action(async () => {
    await api("film/delete", {
      id: currentFilm.id,
      slug: currentFilm.slug,
      expected,
    });
    markDirty("film-form", false);
    currentFilm = null;
    $("#film-editor").hidden = true;
    await load();
    status("Ficha excluída. Para recuperar, escolha Excluídas no filtro.");
  });
});
function renderSelections() {
  const parent = $("#selection-list");
  parent.replaceChildren();
  const selections = state.editorial.selections.filter((selection) =>
    normalize(selection.title).includes(normalize($("#selection-search").value))
  );
  for (const selection of selections) {
    const button = element("button");
    button.className = "selection-card";
    button.setAttribute(
      "aria-pressed",
      String(selection.id === currentSelectionId)
    );
    button.append(
      element("strong", selection.title),
      element(
        "small",
        selection.rule === "manual"
          ? String(selection.filmSlugs.length) + " · " + t("Filmes escolhidos")
          : t("Seleção automática")
      )
    );
    button.addEventListener("click", async () => {
      if (await canLeave("selection-form")) editSelection(selection);
    });
    parent.append(button);
  }
  if (!selections.length)
    parent.append(
      element("p", "Nenhuma seleção encontrada. Crie uma nova seleção.")
    );
}
function filterSelectionFilms() {
  const query = $("#selection-film-search").value;
  const members = $("#selection-films");
  let count = 0;
  for (const label of [...members.querySelectorAll("label")].sort(
    (a, b) =>
      Number(b.querySelector("input").checked) -
      Number(a.querySelector("input").checked)
  )) {
    const input = label.querySelector("input");
    const film = state.films.find((film) => film.slug === input.value);
    if (input.checked) count++;
    label.hidden =
      (selectedOnly && !input.checked) || !filmMatches(film, query);
    members.append(label);
  }
  $("#member-count").textContent = count + " · " + t("Filmes escolhidos");
}
$("#selection-search").addEventListener("input", renderSelections);
$("#selection-film-search").addEventListener("input", filterSelectionFilms);
$("#selection-film-search").addEventListener("keydown", (event) => {
  if (event.key === "Enter") event.preventDefault();
});
$("#selection-films").addEventListener("change", filterSelectionFilms);
$("#selected-only").addEventListener("click", () => {
  selectedOnly = !selectedOnly;
  $("#selected-only").setAttribute("aria-pressed", String(selectedOnly));
  filterSelectionFilms();
});
for (const id of ["film-form", "selection-form", "home-form"]) {
  for (const event of ["input", "change"])
    $("#" + id).addEventListener(event, (event) => {
      if (
        !["selection-film-search", "featured-search"].includes(event.target.id)
      )
        markDirty(id);
    });
}
window.addEventListener("beforeunload", (event) => {
  if (dirtyForms.size) {
    event.preventDefault();
    event.returnValue = "";
  }
});
