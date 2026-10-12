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

const status = (message) => {
  $("#status").textContent = t(message);
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
  const response = await fetch("/api/" + route, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-PVCA-Token": state.token,
    },
    body: JSON.stringify(value),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error);
  return result;
}
async function action(work) {
  for (const button of document.querySelectorAll("button"))
    button.disabled = true;
  try {
    await work();
  } catch (error) {
    status(error.message);
  } finally {
    for (const button of document.querySelectorAll("button"))
      button.disabled = false;
  }
  $("#import-confirm").disabled = !importPlan;
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
  const form = $("#home-form"),
    select = form.elements.featuredSlug;
  select.replaceChildren();
  option(select, "", "Sem destaque");
  for (const film of state.films)
    option(select, film.slug, film.title + " · " + film.year);
  select.value = state.editorial.featuredSlug ?? "";
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
  const picker = $("#film-picker");
  picker.replaceChildren();
  option(picker, "", "Escolha um filme ou crie um novo");
  for (const film of state.catalog)
    option(picker, "catalog:" + film.id, film.title);
  for (const film of state.drafts)
    option(
      picker,
      "draft:" + film.id,
      (film.title || "TMDB #" + film.tmdb_id) + t(" (rascunho)")
    );
  const selections = $("#selection-picker");
  selections.replaceChildren();
  option(selections, "", "Escolha uma seleção");
  for (const selection of state.editorial.selections)
    option(selections, selection.id, selection.title);
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
  const parent = $("#film-fields");
  parent.replaceChildren();
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
    ["title_en", "Título (en)"],
    ["synopsis_pt", "Sinopse (pt-BR)", "textarea"],
    ["synopsis_en", "Sinopse (en)", "textarea"],
    ["note_en", "Nota editorial (en)", "textarea"],
    ["synopsis", "Sinopse", "textarea"],
    ["collection_note", "Nota editorial pública", "textarea"],
  ])
    field(
      parent,
      key,
      label,
      Array.isArray(currentFilm[key])
        ? currentFilm[key].join("; ")
        : currentFilm[key],
      type ?? "text",
      type === "textarea"
    );
  const formFields = $("#film-form").elements;
  formFields.title_en.value = currentFilm.translations?.en?.title ?? "";
  formFields.synopsis_pt.value =
    currentFilm.translations?.["pt-BR"]?.synopsis ?? currentFilm.synopsis ?? "";
  formFields.synopsis_en.value = currentFilm.translations?.en?.synopsis ?? "";
  formFields.note_en.value =
    currentFilm.translations?.en?.collection_note ?? "";
  const poster = field(
    parent,
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
  remove.addEventListener("click", () => parent.remove());
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
  remove.addEventListener("click", () => parent.remove());
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
      title: result.title,
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
      const copy = {};
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
  updateRule();
}
function updateRule() {
  const automated = $("#selection-form").elements.rule.value !== "manual";
  for (const input of $("#selection-films").querySelectorAll("input"))
    input.disabled = automated;
}
for (const button of document.querySelectorAll("[data-tab]"))
  button.addEventListener("click", () => {
    for (const id of ["home", "films", "selections", "import"])
      $("#" + id).hidden = id !== button.dataset.tab;
    for (const tab of document.querySelectorAll("[data-tab]"))
      tab.setAttribute("aria-pressed", String(tab === button));
    status("");
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
    await load();
    status("Início salvo. Gere a prévia para conferir.");
  });
});
$("#home-form").elements.featuredSlug.addEventListener("change", () => {
  $("#home-form").elements.featuredNote.value = "";
});
$("#selection-form").elements.title.addEventListener("input", (event) => {
  if (!currentSelectionId)
    $("#selection-form").elements.id.value = slugify(event.target.value);
});
$("#new-film").addEventListener("click", () => {
  editFilm();
  status("Novo rascunho. Preencha somente informações comprovadas.");
});
$("#film-picker").addEventListener("change", (event) => {
  const value = event.target.value,
    index = value.indexOf(":"),
    source = value.slice(0, index),
    id = value.slice(index + 1);
  const film = state[source === "draft" ? "drafts" : "catalog"].find(
    (f) => f.id === id
  );
  if (film) editFilm(film);
});
$("#add-copy").addEventListener("click", () => {
  if (!currentFilm) {
    status("Crie ou escolha um filme primeiro.");
    return;
  }
  addCopy();
});
$("#add-link").addEventListener("click", () => addLink());
$("#film-form").addEventListener("submit", (event) => {
  event.preventDefault();
  action(async () => {
    const film = collectFilm();
    await api("draft", film);
    await load();
    editFilm(film);
    status("Rascunho salvo. O catálogo do site não foi alterado.");
  });
});
$("#apply").addEventListener("click", () =>
  action(async () => {
    if (!$("#film-form").reportValidity()) return;
    const film = collectFilm();
    await api("apply", film);
    await load();
    editFilm(film);
    status(
      "Filme aplicado ao catálogo local. Gere a prévia para revisar; nada foi publicado."
    );
  })
);
$("#selection-picker").addEventListener("change", (event) =>
  editSelection(
    state.editorial.selections.find((s) => s.id === event.target.value)
  )
);
$("#new-selection").addEventListener("click", () => editSelection());
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
      filmSlugs: [
        ...$("#selection-films").querySelectorAll("input:checked"),
      ].map((input) => input.value),
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
    await load();
    editSelection(selected);
    status("Seleção salva localmente.");
  });
});
$("#remove-selection").addEventListener("click", () =>
  action(async () => {
    if (!currentSelectionId) throw Error("Escolha uma seleção.");
    if (!confirm("Remover esta seleção? Os filmes serão preservados.")) return;
    const config = structuredClone(state.editorial);
    config.selections = config.selections.filter(
      (s) => s.id !== currentSelectionId
    );
    config.homeSelectionIds = config.homeSelectionIds.filter(
      (id) => id !== currentSelectionId
    );
    await api("editorial", config);
    await load();
    editSelection();
    status("Seleção removida; filmes preservados.");
  })
);
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

$("#admin-language").addEventListener("change", (event) => {
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
