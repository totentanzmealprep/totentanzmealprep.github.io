// Meal Prep Picker app. Recipe data and photos load encrypted (see index.html).

const RECIPES = window.__MP.recipes;
const BY_ID = Object.fromEntries(RECIPES.map(r => [r.id, r]));
const AISLE_ORDER = ["Produce","Meat","Deli","Dairy & Eggs","Cheese","Bread & Tortillas","Pasta, Rice & Grains","Canned & Jarred","Sauces & Condiments","International","Spices & Baking","Frozen","Drinks","Other"];
const BOOKS = { sh: "Stealth Health Slow Cooker", mp: "The Meal Prep Cookbook", sv: "Saved recipes" };
const BOOK_SHORT = { sh: "Slow cooker book", mp: "Meal Prep book", sv: "Saved recipe" };
const FILTERS = [
  { key: "book", label: "Book", opts: [["sh","Slow cooker (Stealth Health)"],["mp","Stovetop & oven (Meal Prep Cookbook)"],["sv","Saved recipes"]] },
  { key: "protein", label: "Protein", opts: [["chicken","Chicken"],["beef","Beef"],["pork","Pork"],["seafood","Seafood"]] },
  { key: "format", label: "Style", opts: [["bowl","Rice bowls"],["pasta","Pasta & mac"],["soup","Soups & chili"],["wrap","Burritos & sandwiches"],["potato","Potatoes & fries"],["other","Something different"],["protein","Just the protein"]] },
  { key: "flavor", label: "Flavor", opts: [["cheesy","Cheesy comfort"],["texmex","Tex-Mex & Latin"],["asian","Asian"],["italian","Italian"],["american","American classics"],["med","Mediterranean"],["indian","Indian"],["sweet","Sweet & saucy"],["light","Fresh & lighter"],["lowcarb","Lower carb"]] },
  { key: "heat", label: "Heat", opts: [["0","Mild"],["1","Medium heat"],["2","Spicy"]] },
  { key: "ours", label: "Ours", opts: [["loved","We loved it"],["untried","Haven't tried"],["hide-no","Hide 'not again'"]] },
];
const CUISINE = { texmex:"Tex-Mex / Latin", asian:"Asian", italian:"Italian", american:"American", med:"Mediterranean", indian:"Indian" };
const FORMAT = { bowl:"Rice bowl", pasta:"Pasta", soup:"Soup / chili", wrap:"Burrito / sandwich", potato:"Potatoes & fries", other:"Something different", protein:"Protein only" };
const VERDICTS = [["loved","Loved it"],["fine","It was fine"],["no","Not again"]];

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 120) || "x";
const fmt = n => Math.round(n).toLocaleString("en-US");
const col = n => state._db.collection(`households/${state.hh}/${n}`);
const CODE_RX = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
function newCode() { const a = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; const r = new Uint32Array(8); crypto.getRandomValues(r); const c = [...r].map(x => a[x % a.length]).join(""); return c.slice(0,4) + "-" + c.slice(4); }

// ---------- state ----------
const state = {
  view: "pick", sel: { book:new Set(), protein:new Set(), format:new Set(), flavor:new Set(), heat:new Set(), ours:new Set() },
  q: "", sort: "book",
  picks: new Map(),   // id -> addedAt
  scale: new Map(),   // id -> batch multiplier
  checks: new Set(),  // shopping key slugs
  rec: {},            // id -> {notes, verdict}
  db: null, canWrite: true, local: true,
};

// cook time from steps
for (const r of RECIPES) {
  const txt = r.steps.join(" ");
  const lo = txt.match(/\blow\s+for\s+(\d+(?:\s*[-–]\s*\d+)?)\s*(hours?|hrs?|minutes)/i);
  const hi = txt.match(/\bhigh\s+for\s+(\d+(?:\s*[-–]\s*\d+)?)\s*(hours?|hrs?|minutes)/i);
  const m = lo || hi;
  r.time = (r.book || "sh") === "sh" && m ? `${lo ? "Low" : "High"} ${m[1].replace(/\s*[-–]\s*/, "–")} ${/min/i.test(m[2]) ? "min" : "h"}` : "";
  r.short = r.title.replace(/ Rice Bowls?| Bowls?/i, "").replace(/Mac n[’'] Cheese|Mac N Cheese/i, "Mac");
}

// ---------- local fallback ----------
const LS = "mpp-v1";
function loadLocal() {
  try { const j = JSON.parse(localStorage.getItem(LS) || "{}");
    state.picks = new Map(Object.entries(j.picks || {})); state.scale = new Map(Object.entries(j.scale || {}).map(([k,v]) => [k, +v])); state.checks = new Set(j.checks || []); state.rec = j.rec || {};
  } catch (e) {}
}
function saveLocal() {
  if (!state.local) return;
  try { localStorage.setItem(LS, JSON.stringify({ picks: Object.fromEntries(state.picks), scale: Object.fromEntries(state.scale), checks: [...state.checks], rec: state.rec })); } catch (e) {}
}
function saveUi() { try { localStorage.setItem(LS + "-ui", JSON.stringify({ sel: Object.fromEntries(Object.entries(state.sel).map(([k,v]) => [k,[...v]])), sort: state.sort, view: state.view })); } catch (e) {} }
function loadUi() { try { const j = JSON.parse(localStorage.getItem(LS + "-ui") || "{}"); if (j.sel) for (const k in j.sel) if (state.sel[k]) state.sel[k] = new Set(j.sel[k]); if (j.sort) state.sort = j.sort; if (j.view) state.view = j.view; } catch (e) {} }

// ---------- writes ----------
async function guard(fn) {
  try { await fn(); }
  catch (e) {
    if (e && e.code === "invalid_argument") { state.canWrite = false; toast("You can view this list but not change it."); render(); }
    else if (e && e.code === "unavailable") { try { await new Promise(r => setTimeout(r, 400 + Math.random()*600)); await fn(); } catch (e2) { toast("Couldn't save. Check your connection and try again."); } }
    else toast("Couldn't save that change. Try again.");
  }
}
function togglePick(id) {
  if (!state.canWrite) return;
  const on = state.picks.has(id);
  if (on) state.picks.delete(id); else state.picks.set(id, Date.now());
  saveLocal(); render();
  toast(on ? `Removed ${BY_ID[id].title}` : `Added ${BY_ID[id].title}`);
  if (on) state.scale.delete(id);
  if (state.db) guard(() => on ? col("picks").doc(id).delete() : col("picks").doc(id).set({ at: state.picks.get(id), scale: scaleOf(id) }));
}
function setScale(id, k) {
  if (!state.canWrite) return;
  const wasPicked = state.picks.has(id);
  if (!wasPicked) state.picks.set(id, Date.now());
  if (k === 1) state.scale.delete(id); else state.scale.set(id, k);
  saveLocal(); render(); refreshDrawer();
  toast(`${BY_ID[id].title}: ${scaleLabel(k)} batch${wasPicked ? "" : ", added to this week"}`);
  if (state.db) guard(() => col("picks").doc(id).set({ at: state.picks.get(id), scale: k }));
}
function refreshDrawer() {
  if (!state.open) return;
  const b = document.getElementById("d-body"); const st = b.scrollTop;
  b.innerHTML = recipeBody(BY_ID[state.open]); b.scrollTop = st;
}
function toggleCheck(k) {
  if (!state.canWrite) return;
  const on = state.checks.has(k);
  if (on) state.checks.delete(k); else state.checks.add(k);
  saveLocal(); renderShop(); renderCounts();
  if (state.db) guard(() => on ? col("checks").doc(k).delete() : col("checks").doc(k).set({ at: Date.now() }));
}
const recTimers = {};
function setRec(id, patch, immediate) {
  if (!state.canWrite) return;
  state.rec[id] = { notes: "", verdict: "", ...(state.rec[id] || {}), ...patch };
  saveLocal();
  if (!state.db) return;
  clearTimeout(recTimers[id]);
  const go = () => { const body = { notes: state.rec[id].notes || "", verdict: state.rec[id].verdict || "", at: Date.now() };
    guard(() => col("recipes").doc(id).set(body)).then(() => markSaved(id)); };
  if (immediate) go(); else recTimers[id] = setTimeout(go, 900);
}
function markSaved(id) { document.querySelectorAll(`[data-saved="${id}"]`).forEach(el => { el.textContent = "Saved"; setTimeout(() => el.textContent = "", 1800); }); }
async function clearChecks() {
  const ks = [...state.checks]; state.checks.clear(); saveLocal(); render();
  if (state.db) await Promise.all(ks.map(k => guard(() => col("checks").doc(k).delete())));
}
async function newWeek() {
  const ps = [...state.picks.keys()]; state.picks.clear(); saveLocal();
  await clearChecks();
  if (state.db) await Promise.all(ps.map(id => guard(() => col("picks").doc(id).delete())));
  toast("Cleared. Pick next week's meals."); setView("pick");
}

// ---------- filtering ----------
function matches(r) {
  const s = state.sel;
  const fmtSel = s.format;
  if (fmtSel.size) { if (!fmtSel.has(r.format)) return false; }
  else if (r.kind === "protein") return false;
  if (s.book && s.book.size && !s.book.has(r.book || "sh")) return false;
  if (s.protein.size && !s.protein.has(r.protein)) return false;
  if (s.flavor.size && ![...s.flavor].some(f => r.cuisine === f || r.moods.includes(f))) return false;
  if (s.heat.size && !s.heat.has(String(r.heat))) return false;
  const v = state.rec[r.id]?.verdict || "";
  if (s.ours.has("loved") && v !== "loved") return false;
  if (s.ours.has("untried") && v) return false;
  if (s.ours.has("hide-no") && v === "no") return false;
  if (state.q) {
    const hay = (r.title + " " + r.sections.map(x => x.items.join(" ")).join(" ")).toLowerCase();
    if (!state.q.split(/\s+/).every(w => hay.includes(w))) return false;
  }
  return true;
}
function sorted(list) {
  const by = { book: (a,b) => ({sh:0,mp:1,sv:2}[a.book||"sh"]-{sh:0,mp:1,sv:2}[b.book||"sh"]) || a.page - b.page, protein: (a,b) => (b.p||0) - (a.p||0), cal: (a,b) => (a.cal||9e9) - (b.cal||9e9), carb: (a,b) => (a.c ?? 999) - (b.c ?? 999), serv: (a,b) => (b.servings||0) - (a.servings||0), az: (a,b) => a.title.localeCompare(b.title) }[state.sort];
  return list.slice().sort(by);
}

// ---------- render: pick ----------
function renderFilters() {
  const el = document.getElementById("filters");
  el.innerHTML = FILTERS.map(g => `
    <div class="frow"><div class="eyebrow">${g.label}</div><div class="chips">${g.opts.map(([v,l]) =>
      `<button class="chip${g.key==="heat"?" heat":""}" data-g="${g.key}" data-v="${v}" aria-pressed="${state.sel[g.key].has(v)}">${l}</button>`).join("")}</div></div>`).join("") +
    `<div class="tools"><input class="search" id="q" type="search" placeholder="Search by name or ingredient (e.g. pineapple, orzo)" value="${esc(state.q)}"></div>`;
  el.querySelectorAll(".chip").forEach(b => b.onclick = () => {
    const set = state.sel[b.dataset.g]; set.has(b.dataset.v) ? set.delete(b.dataset.v) : set.add(b.dataset.v);
    b.setAttribute("aria-pressed", set.has(b.dataset.v)); saveUi(); renderGrid();
  });
  const q = document.getElementById("q");
  q.oninput = () => { state.q = q.value.trim().toLowerCase(); renderGrid(); };
}
const HEAT = ["Mild","Medium heat","Spicy"];
function heatDots(h) { return `<span class="heat-wrap"><span class="heatdots" aria-hidden="true">${[0,1,2].map(i => `<i class="${i<=h?"on":""}"></i>`).join("")}</span><span class="heatlbl h${h}">${HEAT[h]}</span></span>`; }
function macroLabel(r) {
  return `<div class="label" role="group" aria-label="Per serving"><div><b>${r.cal ?? "–"}</b><span>cal</span></div><div><b>${r.p ?? "–"}${r.p == null ? "" : "g"}</b><span>protein</span></div><div><b>${r.c ?? "–"}${r.c == null ? "" : "g"}</b><span>carbs</span></div><div><b>${r.f ?? "–"}${r.f == null ? "" : "g"}</b><span>fat</span></div></div>`;
}
function verdictBadge(id) {
  const v = state.rec[id]?.verdict; if (!v) return "";
  return `<span class="badge ${v==="no"?"no":v==="fine"?"ok":""}">${VERDICTS.find(x=>x[0]===v)[1]}</span>`;
}
function card(r) {
  const on = state.picks.has(r.id);
  return `<article class="rcard${on?" picked":""}">
    <button class="photo" data-open="${r.id}" aria-label="Open ${esc(r.title)}"><img data-photo="${r.id}" src="${window.__MP.blank}" alt="" loading="lazy" decoding="async" onerror="this.remove()"><span class="servpill">${r.batch ? "Whole batch" : !r.servings ? "Servings not listed" : `${fmtServ(r.servings * (on ? scaleOf(r.id) : 1))} servings`}${on && scaleOf(r.id) !== 1 ? ` · ${scaleLabel(scaleOf(r.id))}` : ""}</span></button>
    <button class="title" data-open="${r.id}">${esc(r.title)}</button>
    <div class="meta">${heatDots(r.heat)}<span>${CUISINE[r.cuisine]}</span><span>${FORMAT[r.format]}</span>${r.time?`<span>${r.time}</span>`:""}</div>
    <div class="bookline">${BOOK_SHORT[r.book||"sh"]}</div>
    ${macroLabel(r)}
    <div class="rfoot"><span class="meta">${r.batch ? "Macros for whole batch" : !r.servings ? "Servings not listed" : `Makes ${fmtServ(r.servings * (on ? scaleOf(r.id) : 1))}`} ${verdictBadge(r.id)}</span>
      <button class="addbtn${on?" on":""}" data-pick="${r.id}" ${state.canWrite?"":"disabled"} aria-pressed="${on}">${on?"✓ This week":"+ Add"}</button></div>
  </article>`;
}
function renderGrid() {
  const list = sorted(RECIPES.filter(matches));
  const any = Object.values(state.sel).some(s => s.size) || state.q;
  document.getElementById("clear").hidden = !any;
  const kindWord = state.sel.format.has("protein") && state.sel.format.size === 1 ? "proteins" : "meals";
  document.getElementById("count").textContent = `${list.length} ${list.length===1 ? kindWord.replace(/s$/,"") : kindWord}`;
  const g = document.getElementById("grid");
  g.innerHTML = list.length ? list.map(card).join("") : `<div class="empty">Nothing matches all of those. Try fewer moods.</div>`;
  state._list = list;
}

// ---------- shopping list ----------
function shopping() {
  const items = new Map();
  for (const id of state.picks.keys()) {
    const r = BY_ID[id]; if (!r) continue;
    const k = scaleOf(id);
    for (const [key, aisle, pantry, g0, n0, raw] of r.shop) {
      const g = g0 ? g0 * k : g0, n = n0 ? Math.ceil(n0 * k * 2 - 0.01) / 2 : n0;
      if (!items.has(key)) items.set(key, { key, aisle, pantry: !!pantry, g: 0, n: 0, other: 0, lines: [], recipes: new Set(), slug: slug(key) });
      const it = items.get(key);
      if (g) it.g += g; else if (n) it.n += n; else it.other++;
      it.lines.push([r.short, raw]); it.recipes.add(r.short);
    }
  }
  return [...items.values()];
}
// ---------- batch scaling ----------
const SCALES = [0.5, 1, 1.5, 2, 3];
function fmtServ(n) { if (!Number.isFinite(n)) return "?"; return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, ""); }
function scaleOf(id) { return state.scale.get(id) || 1; }
function scaleLabel(k) { return k === 1 ? "as written" : (k === 0.5 ? "½×" : k === 1.5 ? "1½×" : k + "×"); }
const UNITS = new Set(["g","kg","ml","l","oz","lb","lbs","tsp","tbsp","cup","cups","x","each","to","or","and","heaped","heaping","level","approx","about"]);
const UF = { "½":.5, "¼":.25, "¾":.75, "⅓":1/3, "⅔":2/3, "⅛":.125 };
function scaleLine(text, k) {
  if (k === 1) return { t: text, done: true };
  const firstWord = text.search(/\b[A-Za-z]{2,}\b/g);
  let end = text.length; const re = /\b[A-Za-z]{2,}\b/g; let m;
  while ((m = re.exec(text))) { if (!UNITS.has(m[0].toLowerCase())) { end = m.index; break; } }
  const head = text.slice(0, end), tail = text.slice(end);
  let hit = false;
  const out = head.replace(/(\d+(?:\.\d+)?(?:\s?[½¼¾⅓⅔⅛])?|[½¼¾⅓⅔⅛])(?![\d%\/]|-[A-Za-z])(\s*)([A-Za-z]*)/g, (all, num, sp, unit, off, str) => {
    if (str[off - 1] === "/" ) return all;
    const mm = num.match(/^(\d+(?:\.\d+)?)?\s?([½¼¾⅓⅔⅛])?$/); if (!mm) return all;
    const v = (mm[1] ? +mm[1] : 0) + (mm[2] ? UF[mm[2]] : 0); if (!v) return all;
    const x = v * k; hit = true; const u = unit.toLowerCase();
    const f = (u === "g" || u === "ml") ? String(Math.round(x)) : (u === "oz" || u === "lb" || u === "lbs" || u === "kg") ? String(Math.round(x * 10) / 10) : (x >= 10 ? String(Math.round(x)) : frac(x, 0.25));
    return f + sp + unit;
  });
  return { t: out + tail, done: hit };
}
// ---------- US measures ----------
const G_PER_CUP = {"1% milk":245,"Whole milk":245,"Fat-free milk":245,"Fat-free evaporated milk":255,"Plain 0% Greek yogurt (or skyr)":245,"2% cottage cheese":226,"Light sour cream":230,"Low-fat ricotta":246,"Bone broth":240,"Red enchilada sauce":250,"Green enchilada sauce":250,"Soy sauce":255,"Dark soy sauce":255,"Honey":340,"Maple syrup":315,"Light mayo":230,"Sriracha":270,"Buffalo wing sauce":250,"Sugar-free BBQ sauce":270,"Sugar-free ketchup":270,"Worcestershire sauce":275,"Rice vinegar":240,"Apple cider vinegar":240,"Red wine vinegar":240,"Balsamic vinegar":255,"Cooking oil (olive / avocado)":216,"Sesame oil":218,"Orange juice":248,"Light coconut milk":240,"Coconut cream":240,"Tomato paste":262,"Fire-roasted / crushed tomatoes (cans)":245,"Tomato sauce":245,"Sharp cheddar":113,"Reduced-fat cheddar":113,"Mozzarella (reduced fat)":113,"Parmigiano Reggiano":100,"Feta":150,"Gruyère":100,"American cheese":113,"Rice":185,"Basmati rice":185,"Jasmine rice":185,"Short-grain rice":200,"Liquid egg whites":243,"Peanut butter":258,"Gochujang":300,"White miso paste":275,"Harissa paste":260,"Hot sauce":250,"Fish sauce":270,"Oyster sauce":290,"Mirin":260,"Chili garlic sauce":270,"Chili crisp":220,"Pesto":250,"Cornstarch":128,"Flour":125,"Diced green chiles":230,"Spinach":30,"Frozen mixed veggies":140,"Frozen peas":140,"Broccoli florets":90,"Garlic (fresh, minced, or purée)":200,"Ginger (fresh or paste)":200,"Sun-dried tomatoes":110,"Black beans (15 oz can)":172,"Kidney beans (can)":172,"Corn":165,"Sweet chili sauce":300,"Hoisin sauce":290,"Tamarind paste":280,"Dijon mustard":250,"Mustard":250,"Store-bought tzatziki":245,"Pickles":150,"Kimchi":150,"Cashews":140,"Shredded coconut":85,"Cabbage":70,"Bean sprouts":105,"Cherry tomatoes":150,"Tomatoes":180,"Green onions":100,"Cucumber":130,"Bell peppers":150,"Onions (yellow / white / sweet)":160,"Carrots":110,"Mushrooms":70,"Fresh pineapple":165,"Mango":165,};
const NO_WT = new Set(["1% milk","Whole milk","Fat-free milk","Fat-free evaporated milk","Bone broth","Red enchilada sauce","Green enchilada sauce","Soy sauce","Dark soy sauce","Honey","Maple syrup","Sriracha","Buffalo wing sauce","Worcestershire sauce","Rice vinegar","Apple cider vinegar","Red wine vinegar","Balsamic vinegar","Cooking oil (olive / avocado)","Sesame oil","Orange juice","Light coconut milk","Coconut cream","Liquid egg whites","Fish sauce","Mirin","Hot sauce","Oyster sauce","Garlic (fresh, minced, or purée)","Ginger (fresh or paste)","Cornstarch","Flour"]);
const EACH_G = {"Onions (yellow / white / sweet)":[170,"medium onion","medium onions"],"Bell peppers":[160,"bell pepper","bell peppers"],"Tomatoes":[125,"tomato","tomatoes"],"Cucumber":[300,"cucumber","cucumbers"],"Carrots":[70,"carrot","carrots"],"Potatoes (russet or white)":[250,"medium potato","medium potatoes"],"Sweet potatoes":[200,"medium sweet potato","medium sweet potatoes"],"Yukon gold potatoes":[150,"medium Yukon gold","medium Yukon golds"],"Avocados":[150,"avocado","avocados"],"Mango":[200,"mango","mangoes"],"Zucchini":[200,"zucchini","zucchini"],"Fresh pineapple":[900,"whole pineapple","whole pineapples"],"Broccoli florets":[300,"head of broccoli","heads of broccoli"],"Chicken breast":[225,"breast (8 oz)","breasts (8 oz each)"],"Chicken thighs, boneless skinless":[115,"thigh","thighs"],"Salmon":[170,"fillet","fillets"],"Cabbage":[900,"head of cabbage","heads of cabbage"],"Garlic (fresh, minced, or purée)":[5,"clove","cloves"],"Jalapeños / Fresno chiles":[14,"jalapeño","jalapeños"],"Poblano peppers":[120,"poblano","poblanos"],"Green onions":[15,"stalk","stalks"],"Limes":[30,"lime (juiced)","limes (juiced)"],"Lemons":[45,"lemon (juiced)","lemons (juiced)"],"Butter":[113,"stick","sticks"]};
const LB_BOX = [454,"1 lb box","1 lb boxes"];
const PKG = {"1/3-fat cream cheese":[227,"8 oz block","8 oz blocks"],"2% cottage cheese":[454,"16 oz tub","16 oz tubs"],"Plain 0% Greek yogurt (or skyr)":[907,"32 oz tub","32 oz tubs"],"Light sour cream":[454,"16 oz tub","16 oz tubs"],"Butter":[454,"1 lb box (4 sticks)","1 lb boxes"],"Sharp cheddar":[227,"8 oz bag or block","8 oz bags or blocks"],"Reduced-fat cheddar":[227,"8 oz bag","8 oz bags"],"Mozzarella (reduced fat)":[227,"8 oz bag","8 oz bags"],"Parmigiano Reggiano":[142,"5 oz wedge or tub","5 oz wedges or tubs"],"Feta":[170,"6 oz tub","6 oz tubs"],"American cheese":[340,"12 oz pack","12 oz packs"],"Pasta (short shape)":LB_BOX,"Penne":LB_BOX,"Rigatoni":LB_BOX,"Bow tie pasta":LB_BOX,"Linguine":LB_BOX,"Spaghetti":LB_BOX,"Fettuccine":LB_BOX,"Orzo":LB_BOX,"Oven-ready lasagna noodles":[255,"9 oz box","9 oz boxes"],"Egg noodles":[340,"12 oz bag","12 oz bags"],"Rice noodles":[397,"14 oz pack","14 oz packs"],"Rice":[907,"2 lb bag","2 lb bags"],"Basmati rice":[907,"2 lb bag","2 lb bags"],"Jasmine rice":[907,"2 lb bag","2 lb bags"],"Short-grain rice":[907,"2 lb bag","2 lb bags"],"Bone broth":[907,"32 oz carton","32 oz cartons"],"Red enchilada sauce":[283,"10 oz can","10 oz cans"],"Green enchilada sauce":[283,"10 oz can","10 oz cans"],"Fire-roasted / crushed tomatoes (cans)":[411,"14.5 oz can","14.5 oz cans"],"Tomato sauce":[425,"15 oz can","15 oz cans"],"Black beans (15 oz can)":[425,"15 oz can","15 oz cans"],"Kidney beans (can)":[425,"15 oz can","15 oz cans"],"Diced green chiles":[113,"4 oz can","4 oz cans"],"Chipotle peppers in adobo (7 oz cans)":[198,"7 oz can","7 oz cans"],"Tomato paste":[170,"6 oz can","6 oz cans"],"Fat-free evaporated milk":[354,"12 oz can","12 oz cans"],"Light coconut milk":[400,"13.5 oz can","13.5 oz cans"],"Coconut cream":[400,"13.5 oz can","13.5 oz cans"],"Lean ground beef":[454,"1 lb pack","1 lb packs"],"Liquid egg whites":[454,"16 oz carton","16 oz cartons"],"Potatoes (russet or white)":[2268,"5 lb bag","5 lb bags"],"Frozen mixed veggies":[340,"12 oz bag","12 oz bags"],"Frozen peas":[340,"12 oz bag","12 oz bags"],"Spinach":[142,"5 oz box","5 oz boxes"],"Shrimp":[907,"2 lb bag","2 lb bags"],"Frozen fries":[907,"2 lb bag","2 lb bags"],"1% milk":[1892,"half gallon","half gallons"],"Fat-free milk":[1892,"half gallon","half gallons"],"Whole milk":[1892,"half gallon","half gallons"],"Corn":[340,"12 oz bag or can","12 oz bags or cans"]};
function frac(x, step) { const v = Math.round(x / step) * step; const w = Math.floor(v + 1e-9), f = +(v - w).toFixed(2); const F = { 0:"", 0.25:"¼", 0.5:"½", 0.75:"¾" }; return ((w ? String(w) : "") + (F[f] ?? "")) || "0"; }
function cupsStr(c) { if (c >= 0.23) return `${frac(c, 0.25)} cup${c > 1.12 ? "s" : ""}`; const tb = c * 16; if (tb >= 0.9) return `${frac(tb, 0.5)} Tbsp`; return `${frac(tb * 3, 0.5)} tsp`; }
function wt(g) { const oz = g / 28.35; if (oz >= 16) return `${(oz / 16).toFixed(1).replace(/\.0$/, "")} lb`; return `${oz < 10 ? frac(oz, 0.5) : Math.round(oz)} oz`; }
function eachStr(key, g) { const e = EACH_G[key]; if (!e) return ""; const n = g / e[0]; if (n < 0.4) return ""; const r = n < 3 ? Math.max(0.5, Math.round(n * 2) / 2) : Math.round(n); return `${frac(r, 0.5)} ${r > 1 ? e[2] : e[1]}`; }
function usAll(key, g) { const out = (NO_WT.has(key) && G_PER_CUP[key]) ? [] : [wt(g)]; if (G_PER_CUP[key]) out.push(cupsStr(g / G_PER_CUP[key])); const e = eachStr(key, g); if (e) out.push(e); return out; }
function buyHint(key, g) { const p = PKG[key]; if (!p || !g) return ""; const n = Math.max(1, Math.ceil(g / p[0] - 0.1)); return `Buy ${n} × ${n > 1 ? p[2] : p[1]}`; }
function lineUS(text, entry) {
  if (!entry || !entry[3]) return "";
  const [key, , , g] = entry; const parts = [];
  if (!/\b\d[\d.]*\s?(oz|lb)/i.test(text) && !(NO_WT.has(key) && G_PER_CUP[key])) parts.push(wt(g));
  if (G_PER_CUP[key] && !/\b(cups?|tbsp|tsp)\b/i.test(text)) parts.push(cupsStr(g / G_PER_CUP[key]));
  const e = eachStr(key, g); if (e && !/^\s*\d+\s+(medium|large|small)?\s*[a-z]/i.test(text)) parts.push(e);
  return parts.length ? ` <span class="us">≈ ${esc(parts.join(" · "))}</span>` : "";
}
function amount(it) {
  const parts = [];
  if (it.g) {
    parts.push(`${usAll(it.key, it.g).join(" · ")} (${fmt(it.g)} g)`);
  }
  if (it.n) parts.push(`${it.n}${it.g ? " more" : ""}`);
  if (it.other && (it.g || it.n)) parts.push("more");
  if (!parts.length) return it.lines.length > 1 ? `${it.lines.length} uses` : "";
  return parts.join(" + ");
}
function itemRow(it) {
  const done = state.checks.has(it.slug);
  const amt = amount(it);
  return `<div class="item${done?" done":""}">
    <input type="checkbox" id="ck-${it.slug}" data-check="${it.slug}" ${done?"checked":""} ${state.canWrite?"":"disabled"}>
    <div><label for="ck-${it.slug}" class="nm">${esc(it.key)}</label>${amt?` <span class="amt">${esc(amt)}</span>`:""}
      ${buyHint(it.key, it.g) ? `<div class="buy">${esc(buyHint(it.key, it.g))}</div>` : ""}
      <div class="for">${esc([...it.recipes].join(" · "))}</div>
      <details data-k="${it.slug}"${state.openDet && state.openDet.has(it.slug) ? " open" : ""}><summary>What the recipes call for</summary><ul>${it.lines.map(([t,l]) => `<li>${esc(l)} <em>(${esc(t)})</em></li>`).join("")}</ul></details>
    </div></div>`;
}
function aisleBlock(name, list) {
  const left = list.filter(i => !state.checks.has(i.slug)).length;
  return `<section class="aisle"><h3>${esc(name)} <span>${left} left</span></h3>${list.sort((a,b)=>a.key.localeCompare(b.key)).map(itemRow).join("")}</section>`;
}
function renderShop() {
  const body = document.getElementById("shop-body");
  const picks = [...state.picks.keys()].filter(id => BY_ID[id]);
  document.getElementById("weekchips").innerHTML = picks.map(id => `<span class="weekchip">${esc(BY_ID[id].title)} <button data-pick="${id}" aria-label="Remove ${esc(BY_ID[id].title)}" ${state.canWrite?"":"disabled"}>×</button></span>`).join("");
  document.getElementById("shop-tools").hidden = !picks.length;
  if (!picks.length) {
    document.getElementById("shop-sub").textContent = "Nothing picked yet.";
    body.innerHTML = `<div class="empty" style="margin-top:16px">Add meals from the Pick tab and their ingredients show up here, grouped by aisle.<br><br><button class="btn primary" data-goto="pick">Pick meals</button></div>`;
    return;
  }
  const all = shopping();
  const buy = all.filter(i => !i.pantry), pantry = all.filter(i => i.pantry);
  const done = buy.filter(i => state.checks.has(i.slug)).length;
  document.getElementById("checkall").textContent = buy.length && done === buy.length ? "Uncheck all" : "Check all";
  const servings = picks.reduce((s,id) => s + (BY_ID[id].servings || 0) * scaleOf(id), 0);
  document.getElementById("shop-sub").textContent = `${picks.length} recipe${picks.length>1?"s":""} · about ${servings} servings · ${done} of ${buy.length} items in the cart`;
  const groups = AISLE_ORDER.map(a => [a, buy.filter(i => i.aisle === a)]).filter(([,l]) => l.length);
  state.openDet = new Set([...body.querySelectorAll("details[data-k][open]")].map(d => d.dataset.k));
  const pd = document.getElementById("pantry-det"); if (pd) state.pantryOpen = pd.open;
  const focusId = document.activeElement && body.contains(document.activeElement) ? document.activeElement.id : "";
  body.innerHTML = `<div class="progress"><i style="width:${buy.length ? (done/buy.length*100) : 0}%"></i></div>
    <div class="aisles">${groups.map(([a,l]) => aisleBlock(a, l)).join("")}</div>
    ${pantry.length ? `<details class="pantry" id="pantry-det"${state.pantryOpen ? " open" : ""}><summary>Check the pantry (${pantry.length} staples)</summary>
      <p class="sub" style="margin-top:0">Spices, oils, vinegars, and sauces you probably already have. Tick anything you need to grab.</p>
      <div class="aisles">${aisleBlock("Pantry staples", pantry)}</div></details>` : ""}`;
  if (focusId) { const f = document.getElementById(focusId); if (f) f.focus({ preventScroll: true }); }
}
function listText() {
  const all = shopping().filter(i => !state.checks.has(i.slug));
  const out = [`Meal prep: ${[...state.picks.keys()].map(id => BY_ID[id]?.title).filter(Boolean).join(", ")}`, ""];
  for (const a of AISLE_ORDER) {
    const l = all.filter(i => i.aisle === a && !i.pantry); if (!l.length) continue;
    out.push(a.toUpperCase()); l.forEach(i => { const am = amount(i); out.push(`- ${i.key}${am ? " (" + am + ")" : ""}`); }); out.push("");
  }
  return out.join("\n").trim();
}

// ---------- recipe body ----------
function recipeBody(r, opts = {}) {
  const conv = Object.fromEntries((r.shop || []).map(x => [x[5], x]));
  const k = state.picks.has(r.id) ? scaleOf(r.id) : 1;
  const ingLi = i => { const sl = scaleLine(i, k); const e = conv[i] && conv[i][3] ? [conv[i][0], 0, 0, conv[i][3] * k] : null; return `<li>${esc(sl.t)}${k !== 1 && !sl.done ? ` <span class="us">(${scaleLabel(k)})</span>` : ""}${lineUS(i, e)}</li>`; };
  const scaleCtl = (r.batch || !r.servings) ? "" : `<div class="scalebox"><div><div class="eyebrow">Batch size</div><div class="scaleserv">Makes <b>${fmtServ(r.servings * k)}</b> servings${k !== 1 ? ` <span class="us">(book: ${r.servings})</span>` : ""}</div></div><div class="chips">${SCALES.map(x => `<button class="chip" data-scale="${x}" data-id="${r.id}" aria-pressed="${k === x}" ${state.canWrite ? "" : "disabled"}>${x === 1 ? "1× (book)" : scaleLabel(x)}</button>`).join("")}</div></div>`;
  const v = state.rec[r.id] || {};
  return `<div class="recipe">
    <img class="hero" data-photo="${r.id}" src="${window.__MP.blank}" alt="${esc(r.title)}" decoding="async" onerror="this.remove()">
    ${opts.head ? "" : `<div><h2>${esc(r.title)}</h2><div class="meta" style="margin-top:6px">${heatDots(r.heat)}<span>${CUISINE[r.cuisine]}</span><span>${FORMAT[r.format]}</span>${r.time?`<span>${r.time}</span>`:""}<span>${BOOKS[r.book||"sh"]}${r.book==="sv"?"":`, p. ${r.page}`}</span></div>${r.blurb?`<p class="sub" style="margin-top:8px">${esc(r.blurb)}</p>`:""}</div>`}
    ${macroLabel(r)}
    <div class="meta">${r.batch ? "Macros are for the whole batch." : r.cal == null ? "No macros listed for this recipe." : "Macros are per serving."}</div>
    ${scaleCtl}
    <div><div class="eyebrow" style="margin-bottom:2px">Ingredients</div><p class="sub" style="margin:0 0 8px;font-size:13px">Gray ≈ amounts are US equivalents (weight, cups, or how many) and are approximate.</p>
      <div class="ingsec">${r.sections.map(s => `<div>${s.name?`<h4>${esc(s.name)}</h4>`:""}<ul>${s.items.map(ingLi).join("")}</ul></div>`).join("")}</div></div>
    <div><div class="eyebrow" style="margin-bottom:8px">Steps</div><ol class="steps">${r.steps.map(s => `<li><div>${esc(s)}</div></li>`).join("")}</ol></div>
    ${r.notes ? `<div class="booknote"><strong>From the book:</strong> ${esc(r.notes.replace(/^\*/,"").replace(/\s\*/g," "))}</div>` : ""}
    ${r.ours ? `<div class="booknote" style="background:var(--accent-soft)"><strong>Our version:</strong> ${esc(r.ours.replace(/^Our version[^:]*:\s*/,""))}</div>` : ""}
    <div class="ours">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><div class="eyebrow">Our notes</div><span class="saved" data-saved="${r.id}"></span></div>
      <div class="verdicts">${VERDICTS.map(([k,l]) => `<button class="chip" data-verdict="${k}" data-id="${r.id}" aria-pressed="${v.verdict===k}" ${state.canWrite?"":"disabled"}>${l}</button>`).join("")}</div>
      <textarea id="notes-${r.id}" data-notes="${r.id}" placeholder="Swaps, tweaks, what to change next time" ${state.canWrite?"":"disabled"}>${esc(v.notes || "")}</textarea>
    </div>
  </div>`;
}
function openRecipe(id) {
  const r = BY_ID[id]; if (!r) return;
  state.open = id; state.hhOpen = false;
  const on = state.picks.has(id);
  document.getElementById("d-eyebrow").innerHTML = `<button class="addbtn${on?" on":""}" data-pick="${id}" ${state.canWrite?"":"disabled"}>${on?"✓ This week":"+ Add to this week"}</button>`;
  document.getElementById("d-body").innerHTML = recipeBody(r);
  document.getElementById("drawer").classList.add("show");
  document.getElementById("drawer").setAttribute("aria-hidden", "false");
  document.getElementById("scrim").classList.add("show");
  document.getElementById("d-body").scrollTop = 0;
  document.getElementById("d-close").focus({ preventScroll: true });
}
function closeRecipe() {
  state.open = null; state.hhOpen = false;
  document.getElementById("drawer").classList.remove("show");
  document.getElementById("drawer").setAttribute("aria-hidden", "true");
  document.getElementById("scrim").classList.remove("show");
}

// ---------- render: cook ----------
function renderCook() {
  const picks = [...state.picks.entries()].sort((a,b) => a[1]-b[1]).map(([id]) => BY_ID[id]).filter(Boolean);
  const el = document.getElementById("cooklist");
  if (!picks.length) { el.innerHTML = `<div class="empty">No recipes picked for this week yet.<br><br><button class="btn primary" data-goto="pick">Pick meals</button></div>`; return; }
  // keep focus/typing safe: don't rebuild a card whose textarea is focused
  const active = document.activeElement?.dataset?.notes;
  if (active && el.querySelector(`[data-notes="${active}"]`)) { el.querySelectorAll(".chip[data-verdict]").forEach(b => b.setAttribute("aria-pressed", (state.rec[b.dataset.id]?.verdict||"") === b.dataset.verdict)); return; }
  el.innerHTML = picks.map(r => `<article class="cookcard">
    <div class="chead"><div><h2>${esc(r.title)}</h2><div class="meta" style="margin-top:6px">${heatDots(r.heat)}<span>${CUISINE[r.cuisine]}</span>${r.time?`<span>${r.time}</span>`:""}<span>${BOOKS[r.book||"sh"]}${r.book==="sv"?"":`, p. ${r.page}`}</span></div></div>
      <button class="btn ghost" data-pick="${r.id}" ${state.canWrite?"":"disabled"}>Remove from week</button></div>
    ${recipeBody(r, { head: true })}</article>`).join("");
}

// ---------- shell ----------
function renderCounts() {
  const n = state.picks.size;
  document.getElementById("n-cook").textContent = n;
  const buy = shopping().filter(i => !i.pantry);
  document.getElementById("n-shop").textContent = buy.filter(i => !state.checks.has(i.slug)).length;
  const wb = document.getElementById("weekbar");
  wb.classList.toggle("show", n > 0 && state.view === "pick");
  const titles = [...state.picks.keys()].map(id => BY_ID[id]?.short).filter(Boolean);
  const serv = [...state.picks.keys()].reduce((s,id) => s + (BY_ID[id]?.servings || 0) * scaleOf(id), 0);
  document.getElementById("wb-count").textContent = `This week: ${n} recipe${n===1?"":"s"} · ~${serv} servings`;
  document.getElementById("wb-names").textContent = titles.join(" + ");
}
function render() {
  renderGrid(); renderShop(); renderCook(); renderCounts();
  if (state.open) {
    const on = state.picks.has(state.open);
    const b = document.querySelector("#d-eyebrow .addbtn");
    if (b) { b.classList.toggle("on", on); b.textContent = on ? "✓ This week" : "+ Add to this week"; }
    const focused = document.activeElement?.dataset?.notes === state.open;
    if (!focused) { const ta = document.querySelector(`#d-body [data-notes]`); if (ta) ta.value = state.rec[state.open]?.notes || ""; }
    document.querySelectorAll("#d-body .chip[data-verdict]").forEach(b => b.setAttribute("aria-pressed", (state.rec[state.open]?.verdict||"") === b.dataset.verdict));
  }
}
function setView(v) {
  state.view = v; saveUi();
  for (const k of ["pick","shop","cook"]) {
    document.getElementById("view-" + k).hidden = k !== v;
    document.getElementById("tab-" + k).setAttribute("aria-selected", k === v);
  }
  renderCounts(); window.scrollTo({ top: 0 });
}
let toastT; function toast(msg) { const t = document.getElementById("toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 1800); }

// ---------- events ----------
document.addEventListener("click", e => {
  const t = e.target.closest("button, [data-check]"); if (!t) { return; }
  if (t.dataset.view) return setView(t.dataset.view);
  if (t.dataset.goto) return setView(t.dataset.goto);
  if (t.dataset.pick) { e.stopPropagation(); return togglePick(t.dataset.pick); }
  if (t.dataset.open) return openRecipe(t.dataset.open);
  if (t.dataset.scale) { setScale(t.dataset.id, +t.dataset.scale); return; }
  if (t.dataset.verdict) { const id = t.dataset.id; const cur = state.rec[id]?.verdict; setRec(id, { verdict: cur === t.dataset.verdict ? "" : t.dataset.verdict }, true); render(); return; }
});
document.addEventListener("change", e => { const k = e.target.dataset?.check; if (k) toggleCheck(k); });
document.addEventListener("input", e => { const id = e.target.dataset?.notes; if (id) { setRec(id, { notes: e.target.value }); document.querySelectorAll(`[data-notes="${id}"]`).forEach(o => { if (o !== e.target) o.value = e.target.value; }); } });
document.getElementById("scrim").onclick = closeRecipe;
document.getElementById("d-close").onclick = closeRecipe;
document.addEventListener("keydown", e => { if (e.key === "Escape" && state.open) closeRecipe(); });
document.getElementById("clear").onclick = () => { for (const k in state.sel) state.sel[k].clear(); state.q = ""; saveUi(); renderFilters(); renderGrid(); };
document.getElementById("sort").onchange = e => { state.sort = e.target.value; saveUi(); renderGrid(); };
document.getElementById("surprise").onclick = () => { const l = state._list || []; if (!l.length) return toast("Nothing to pick from. Try fewer moods."); openRecipe(l[Math.floor(Math.random()*l.length)].id); };
document.getElementById("wb-go").onclick = () => setView("shop");
document.getElementById("checkall").onclick = async () => {
  if (!state.canWrite) return;
  const buy = shopping().filter(i => !i.pantry);
  const allDone = buy.length && buy.every(i => state.checks.has(i.slug));
  if (allDone) return clearChecks();
  const add = buy.map(i => i.slug).filter(k => !state.checks.has(k));
  add.forEach(k => state.checks.add(k)); saveLocal(); renderShop(); renderCounts();
  if (state.db) await Promise.all(add.map(k => guard(() => col("checks").doc(k).set({ at: Date.now() }))));
};
document.getElementById("copy").onclick = async () => {
  const txt = listText();
  try { await navigator.clipboard.writeText(txt); toast("Copied the list"); }
  catch (e) { const ta = document.createElement("textarea"); ta.value = txt; ta.style.cssText = "position:fixed;left:-9999px"; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); toast("Copied the list"); } catch (e2) { toast("Couldn't copy. Select the items by hand."); } ta.remove(); }
};
const nwWrap = document.getElementById("newweek-wrap");
nwWrap.addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.id === "newweek") nwWrap.innerHTML = `<span class="confirm">Clear this week's picks and checkmarks? <button class="btn danger" id="nw-yes">Clear</button><button class="btn ghost" id="nw-no">Keep</button></span>`;
  else if (b.id === "nw-yes") { nwWrap.innerHTML = `<button class="btn danger" id="newweek">Start a new week</button>`; newWeek(); }
  else if (b.id === "nw-no") nwWrap.innerHTML = `<button class="btn danger" id="newweek">Start a new week</button>`;
});

// ---------- households ----------
let unsubs = [];
async function useHousehold(code, boot) {
  unsubs.forEach(u => { try { u(); } catch (e) {} }); unsubs = [];
  state.hh = code; state.db = state._db;
  try { localStorage.setItem(LS + "-hh", code); } catch (e) {}
  if (state.uid && state.canWrite) { try { await state._db.doc(`data/users/${state.uid}/prefs`).set({ household: code, at: Date.now() }); } catch (e) {} }
  if (!boot) { state.picks = new Map(); state.scale = new Map(); state.checks = new Set(); state.rec = {}; render(); }
  unsubs.push(col("picks").onSnapshot(s => { state.picks = new Map(s.docs.map(d => [d.id, d.data()?.at || 0])); state.scale = new Map(s.docs.filter(d => (d.data()?.scale || 1) !== 1).map(d => [d.id, +d.data().scale])); render(); }, () => {}));
  unsubs.push(col("checks").onSnapshot(s => { state.checks = new Set(s.docs.map(d => d.id)); renderShop(); renderCounts(); }, () => {}));
  unsubs.push(col("recipes").onSnapshot(s => {
    const rec = {}; s.docs.forEach(d => { const x = d.data() || {}; rec[d.id] = { notes: x.notes || "", verdict: x.verdict || "" }; });
    const typing = document.activeElement?.dataset?.notes;
    if (typing && state.rec[typing]) rec[typing] = { ...(rec[typing] || {}), notes: state.rec[typing].notes };
    state.rec = rec; render();
  }, () => {}));
  if (state.hhOpen) openHousehold();
}
function openHousehold() {
  state.open = null; state.hhOpen = true;
  document.getElementById("d-eyebrow").textContent = "Household";
  document.getElementById("d-body").innerHTML = `<div class="hh">
    <div><h2>Your household</h2><p class="sub">Everyone using the same code shares one set of picks, one shopping list, and the same notes and ratings. Anyone with a different code has their own separate list.</p></div>
    <div><div class="eyebrow" style="margin-bottom:6px">Your code</div>
      <div class="hhcode"><span id="hh-code">${esc(state.hh)}</span><button class="btn" id="hh-copy">Copy code</button></div>
      <p class="sub">Give this code to your partner so you share one list. Friends you share the page with get their own code automatically.</p></div>
    <div><div class="eyebrow" style="margin-bottom:6px">Join someone's household</div>
      <form class="hhjoin" id="hh-form"><input id="hh-input" maxlength="9" placeholder="ABCD-EF23" autocomplete="off" aria-label="Household code"><button class="btn primary" type="submit">Join</button></form>
      <div class="hherr" id="hh-err"></div></div>
    <div><div class="eyebrow" style="margin-bottom:6px">Start over</div>
      <p class="sub" style="margin-top:0">Leave this household and start a new, empty one with a new code.</p>
      <span id="hh-new-wrap"><button class="btn danger" id="hh-new">Start my own household</button></span></div>
  </div>`;
  document.getElementById("drawer").classList.add("show");
  document.getElementById("drawer").setAttribute("aria-hidden", "false");
  document.getElementById("scrim").classList.add("show");
}
document.getElementById("hh-btn").onclick = openHousehold;
document.getElementById("d-body").addEventListener("submit", async e => {
  if (e.target.id !== "hh-form") return;
  e.preventDefault();
  let v = document.getElementById("hh-input").value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (v.length === 8) v = v.slice(0,4) + "-" + v.slice(4);
  const err = document.getElementById("hh-err");
  if (!CODE_RX.test(v)) { err.textContent = "Codes look like ABCD-EF23: 8 letters and numbers."; return; }
  if (v === state.hh) { err.textContent = "You're already in that household."; return; }
  await useHousehold(v); toast("Joined household " + v);
});
document.getElementById("d-body").addEventListener("click", async e => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.id === "hh-copy") { try { await navigator.clipboard.writeText(state.hh); toast("Copied " + state.hh); } catch (x) { const r = document.createRange(); r.selectNodeContents(document.getElementById("hh-code")); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); toast("Code selected. Copy it from here."); } }
  if (b.id === "hh-new") document.getElementById("hh-new-wrap").innerHTML = `<span class="confirm">Leave ${esc(state.hh)} and start fresh? <button class="btn danger" id="hh-new-yes">Start fresh</button><button class="btn ghost" id="hh-new-no">Cancel</button></span>`;
  if (b.id === "hh-new-no") openHousehold();
  if (b.id === "hh-new-yes") { await useHousehold(newCode()); toast("New household started"); }
});

// ---------- boot ----------
loadUi(); loadLocal();
document.getElementById("sort").value = state.sort;
const mealCount = RECIPES.filter(r => r.kind === "meal").length;
document.getElementById("pick-sub").textContent = `${mealCount} meals and ${RECIPES.length - mealCount} batch proteins from the Stealth Health Slow Cooker Cookbook, The Meal Prep Cookbook, and recipes you've saved. Tap a few moods, add what sounds good, and the shopping list builds itself.`;
renderFilters(); setView(state.view); render();

(async () => {
  const sync = document.getElementById("sync");
  let db = null, user = null;
  try { db = window.__MP.makeDb(); user = window.__MP.user; } catch (e) { console.error(e); }
  if (!db) { sync.textContent = (window.__MP.demo ? "Preview: nothing is saved. Your picks and list reset when you reload the page." : "Saving on this device only. Syncing is not set up yet."); sync.classList.add("show"); return; }
  state._db = db; state.local = false;
  try { const w = await user?.can?.("data.write"); if (w === false) { state.canWrite = false; sync.textContent = "View only. Ask whoever shared this page for edit access to make changes."; sync.classList.add("show"); } } catch (e) {}
  state.user = user;
  let uid = null; try { uid = await user?.id?.(); } catch (e) {}
  state.uid = uid;
  let hh = null;
  try { const cached = localStorage.getItem(LS + "-hh"); if (cached && CODE_RX.test(cached)) hh = cached; } catch (e) {}
  if (uid) { try { const d = await db.doc(`data/users/${uid}/prefs`).get(); const v = d.exists && d.data()?.household; if (v && CODE_RX.test(v)) hh = v; } catch (e) {} }
  if (!hh) { try { const d = await db.doc("meta/owner").get(); const v = d.exists && d.data()?.household; if (v && CODE_RX.test(v)) hh = v; } catch (e) {} }
  if (!hh) hh = newCode();
  await useHousehold(hh, true);
  document.getElementById("hh-btn").hidden = false;
})();
