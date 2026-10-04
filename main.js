"use strict";

const {
  Component,
  ItemView,
  Keymap,
  MarkdownRenderer,
  Modal,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  normalizePath,
  requestUrl,
  setIcon,
} = require("obsidian");

const VIEW_TYPE = "daily-hub-view";
const DATE_NAME_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];
const WEEKDAY_FULL = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
const AI_START = "<!-- daily-hub:ai-start -->";
const AI_END = "<!-- daily-hub:ai-end -->";

const DEFAULT_MEMO = [
  "把每天的想法写下来，执行力会高一点。",
  "- 待办：必须要做的事",
  "- 想做：想做，但不是必要",
  "- 规划：按时间或空间顺序要执行的事",
].join("\n");

const DEFAULT_SETTINGS = {
  title: "我的笔记",
  dateRecordFolder: "日期记录",
  projectRoot: "项目",
  ignoredFolderNames: ["attachments", "assets", "附件"],
  excludedFolderPrefixes: [],
  projectOrder: [],
  archivedProjects: [],
  launcherLimit: 10,
  memo: DEFAULT_MEMO,
  showMemo: true,
  clampLongNotes: true,
  phoneWeekView: true,
  openOnStartup: false,
  replaceNewTabs: false,
  aiBaseUrl: "https://api.deepseek.com",
  aiApiKey: "",
  aiModel: "deepseek-chat",
  aiExtraPrompt: "",
  projectHints: "",
};

/* ---------- helpers ---------- */

const pad = (n) => String(n).padStart(2, "0");
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseKey = (k) => {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y, m - 1, d, 12);
};
const monthStart = (d) => new Date(d.getFullYear(), d.getMonth(), 1, 12);
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, 12);
const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1, 12);
const weekStart = (d) => addDays(d, -((d.getDay() + 6) % 7));
const monthPrefix = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const shortDate = (k) => {
  const d = parseKey(k);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
};

function greeting(hour) {
  if (hour < 5) return "夜深了";
  if (hour < 9) return "早上好";
  if (hour < 12) return "上午好";
  if (hour < 14) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

function isFolder(item) {
  return Boolean(item) && Array.isArray(item.children);
}

function collectProjectTargets(folder, rootPath, ignored, out = []) {
  const children = Array.isArray(folder?.children) ? folder.children : [];
  const sub = children.filter((c) => isFolder(c) && !ignored.has(c.name));
  const hasMd = children.some((c) => c?.extension === "md");
  if (folder.path !== rootPath && (hasMd || sub.length === 0)) out.push(folder);
  for (const f of sub) collectProjectTargets(f, rootPath, ignored, out);
  return out;
}

function stripAiBlock(text) {
  const s = text.indexOf(AI_START);
  const e = text.indexOf(AI_END);
  if (s === -1 || e === -1 || e < s) return text;
  return (text.slice(0, s) + text.slice(e + AI_END.length)).trim();
}

/* ---------- view ---------- */

class DailyHubView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.navigation = true;
    const now = new Date();
    this.selectedDate = keyOf(now);
    this.visibleMonth = monthStart(now);
    this.calMode = Platform.isPhone && plugin.settings.phoneWeekView ? "week" : "month";
    this.calProject = ""; // 日历按项目筛选（文件夹路径）
    this.manage = false;
    this.launcherExpanded = false;
    this.showArchived = false;
    this.folderSelection = new Map();
    this.filesByDate = new Map();
    this.notesComponent = null;
    this.memoComponent = null;
    this.notesToken = 0;
    this.aiBusy = false;
    this.els = {};
  }

  getViewType() {
    return VIEW_TYPE;
  }
  getDisplayText() {
    return `${this.plugin.settings.title} · 主页`;
  }
  getIcon() {
    return "layout-dashboard";
  }

  async onOpen() {
    this.buildIndex();
    this.renderAll();
  }

  async onClose() {
    this.disposeComponent("notesComponent");
    this.disposeComponent("memoComponent");
  }

  disposeComponent(name) {
    if (!this[name]) return;
    this.removeChild(this[name]);
    this[name] = null;
  }

  get s() {
    return this.plugin.settings;
  }

  /* ----- data ----- */

  buildIndex() {
    const excluded = this.s.excludedFolderPrefixes
      .map((p) => p.trim().replace(/\\/g, "/"))
      .filter(Boolean);
    const map = new Map();
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!DATE_NAME_PATTERN.test(file.basename)) continue;
      if (excluded.some((p) => file.path.startsWith(p))) continue;
      if (Number.isNaN(parseKey(file.basename).getTime())) continue;
      const list = map.get(file.basename) || [];
      list.push(file);
      map.set(file.basename, list);
    }
    this.filesByDate = map;
  }

  /** 所有项目（含日期记录），已按用户顺序排好 */
  projects() {
    return this.plugin.getProjects();
  }

  projectByPath(path) {
    return this.projects().find((p) => p.path === path);
  }

  labelForFolder(path) {
    const p = this.projectByPath(path);
    if (p) return p.label;
    const root = this.s.projectRoot;
    if (path.startsWith(`${root}/`)) return path.slice(root.length + 1).split("/").join(" / ");
    return path || "根目录";
  }

  rankForFolder(path, list) {
    const i = list.findIndex((p) => p.path === path);
    return i === -1 ? 100000 : i;
  }

  filesFor(key) {
    const files = this.filesByDate.get(key) || [];
    if (!this.calProject) return files;
    return files.filter((f) => f.parent?.path === this.calProject);
  }

  countOf(key) {
    return this.filesFor(key).length;
  }

  stats() {
    const todayKey = keyOf(new Date());
    const prefix = monthPrefix(this.visibleMonth);
    let monthDays = 0;
    let total = 0;
    for (const [k, files] of this.filesByDate) {
      total += files.length;
      if (k.startsWith(prefix)) monthDays += 1;
    }
    let cursor = parseKey(todayKey);
    if (!this.filesByDate.has(todayKey)) cursor = addDays(cursor, -1);
    let streak = 0;
    while (this.filesByDate.has(keyOf(cursor))) {
      streak += 1;
      cursor = addDays(cursor, -1);
    }
    return { monthDays, total, streak };
  }

  projectDates(path) {
    const out = [];
    for (const [k, files] of this.filesByDate) {
      if (files.some((f) => f.parent?.path === path)) out.push(k);
    }
    return out.sort();
  }

  pickInitialDate(month) {
    const prefix = monthPrefix(month);
    const dates = [...this.filesByDate.keys()]
      .filter((k) => k.startsWith(prefix) && this.countOf(k) > 0)
      .sort();
    const todayKey = keyOf(new Date());
    if (prefix === todayKey.slice(0, 7)) {
      if (this.countOf(todayKey)) return todayKey;
      return dates.find((k) => k >= todayKey) || dates.at(-1) || todayKey;
    }
    return dates[0] || `${prefix}-01`;
  }

  /** 当天内容分组：日期记录最前，其余按项目顺序 */
  groupFiles(files) {
    const list = this.projects();
    const groups = new Map();
    for (const f of files) {
      const path = f.parent?.path || "";
      const g = groups.get(path) || { path, label: this.labelForFolder(path), files: [] };
      g.files.push(f);
      groups.set(path, g);
    }
    for (const g of groups.values()) g.files.sort((a, b) => a.path.localeCompare(b.path, "zh-CN"));
    return new Map(
      [...groups.entries()].sort(
        ([a, ga], [b, gb]) =>
          this.rankForFolder(a, list) - this.rankForFolder(b, list) ||
          ga.label.localeCompare(gb.label, "zh-CN")
      )
    );
  }

  selectionFor(key, groups) {
    if (!this.folderSelection.has(key)) this.folderSelection.set(key, new Set(groups.keys()));
    const sel = this.folderSelection.get(key);
    for (const name of [...sel]) if (!groups.has(name)) sel.delete(name);
    return sel;
  }

  async openFile(file, evt) {
    const newTab = evt ? Keymap.isModEvent(evt) : false;
    const leaf = this.app.workspace.getLeaf(newTab);
    await leaf.openFile(file, { active: true, state: { mode: "source", source: false } });
  }

  /* ----- selection changes ----- */

  selectDate(key) {
    this.selectedDate = key;
    const d = parseKey(key);
    if (monthPrefix(d) !== monthPrefix(this.visibleMonth)) this.visibleMonth = monthStart(d);
    this.renderHero();
    this.renderCalendar();
    this.renderLauncher();
    this.renderDay();
  }

  shiftCalendar(dir) {
    if (this.calMode === "week") {
      this.selectDate(keyOf(addDays(parseKey(this.selectedDate), dir * 7)));
      return;
    }
    this.visibleMonth = addMonths(this.visibleMonth, dir);
    this.selectDate(this.pickInitialDate(this.visibleMonth));
  }

  showProjectTimeline(path) {
    this.calProject = path;
    if (path) {
      const dates = this.projectDates(path);
      if (dates.length && !dates.includes(this.selectedDate)) {
        this.selectDate(dates.at(-1));
      } else {
        this.renderCalendar();
      }
    } else {
      this.renderCalendar();
    }
    this.els.calendar?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* ----- full render ----- */

  renderAll() {
    const prevScroll = this.els.scroll?.scrollTop || 0;
    const root = this.contentEl;
    root.empty();
    root.addClass("dh-view");
    if (Platform.isMobile) root.addClass("dh-is-mobile");

    const scroll = root.createDiv({ cls: "dh-scroll" });
    const page = scroll.createDiv({ cls: "dh-page" });
    this.els = { scroll };
    this.els.hero = page.createDiv({ cls: "dh-hero" });

    const grid = page.createDiv({ cls: "dh-grid" });
    const side = grid.createDiv({ cls: "dh-side" });
    const main = grid.createDiv({ cls: "dh-main" });

    this.els.calendar = side.createEl("section", { cls: "dh-card dh-calendar-card" });
    this.els.memo = side.createEl("section", { cls: "dh-card dh-memo-card" });
    this.els.launcher = main.createEl("section", { cls: "dh-card dh-launcher" });
    this.els.day = main.createEl("section", { cls: "dh-day" });

    this.renderHero();
    this.renderCalendar();
    this.renderLauncher();
    this.renderMemo();
    this.renderDay();
    scroll.scrollTop = prevScroll;
  }

  refresh() {
    this.buildIndex();
    const prev = this.els.scroll?.scrollTop || 0;
    this.renderHero();
    this.renderCalendar();
    this.renderLauncher();
    this.renderDay();
    if (this.els.scroll) this.els.scroll.scrollTop = prev;
  }

  /* ----- hero ----- */

  renderHero() {
    const el = this.els.hero;
    if (!el) return;
    el.empty();
    const now = new Date();
    const { monthDays, total, streak } = this.stats();

    const top = el.createDiv({ cls: "dh-hero-top" });
    const text = top.createDiv({ cls: "dh-hero-text" });
    text.createDiv({ cls: "dh-hero-eyebrow", text: `${greeting(now.getHours())} · ${this.s.title}` });
    text.createEl("h1", { cls: "dh-hero-title", text: `${now.getMonth() + 1} 月 ${now.getDate()} 日` });
    text.createDiv({ cls: "dh-hero-sub", text: `${WEEKDAY_FULL[now.getDay()]} · ${now.getFullYear()}` });

    const actions = top.createDiv({ cls: "dh-hero-actions" });
    const todayBtn = actions.createEl("button", { cls: "dh-btn dh-btn-soft", attr: { "aria-label": "回到今天" } });
    setIcon(todayBtn.createSpan({ cls: "dh-btn-icon" }), "calendar-check");
    todayBtn.createSpan({ cls: "dh-btn-label", text: "今天" });
    todayBtn.addEventListener("click", () => {
      this.visibleMonth = monthStart(new Date());
      this.selectDate(keyOf(new Date()));
    });
    const refreshBtn = actions.createEl("button", { cls: "dh-btn dh-btn-icon-only", attr: { "aria-label": "刷新" } });
    setIcon(refreshBtn, "refresh-cw");
    refreshBtn.addEventListener("click", () => this.refresh());

    const stats = el.createDiv({ cls: "dh-stats" });
    const stat = (icon, value, label) => {
      const s = stats.createDiv({ cls: "dh-stat" });
      setIcon(s.createSpan({ cls: "dh-stat-icon" }), icon);
      const t = s.createDiv({ cls: "dh-stat-text" });
      t.createDiv({ cls: "dh-stat-value", text: String(value) });
      t.createDiv({ cls: "dh-stat-label", text: label });
    };
    stat("flame", streak, "连续记录天数");
    stat("calendar-days", monthDays, `${this.visibleMonth.getMonth() + 1} 月有记录的天数`);
    stat("files", total, "日期笔记总数");
  }

  /* ----- calendar + timeline ----- */

  renderCalendar() {
    const card = this.els.calendar;
    if (!card) return;
    card.empty();
    const isWeek = this.calMode === "week";
    const sel = parseKey(this.selectedDate);
    const ref = isWeek ? sel : this.visibleMonth;

    // 项目筛选
    const filterRow = card.createDiv({ cls: "dh-cal-filter" });
    setIcon(filterRow.createSpan({ cls: "dh-cal-filter-icon" }), "folder-search");
    const select = filterRow.createEl("select", { cls: "dropdown dh-select" });
    select.createEl("option", { text: "日历显示：全部笔记", attr: { value: "" } });
    const all = this.projects();
    const active = all.filter((p) => !p.archived);
    const archived = all.filter((p) => p.archived);
    for (const p of active) select.createEl("option", { text: p.label, attr: { value: p.path } });
    if (archived.length) {
      const og = select.createEl("optgroup", { attr: { label: "已存档" } });
      for (const p of archived) og.createEl("option", { text: p.label, attr: { value: p.path } });
    }
    select.value = this.calProject;
    select.addEventListener("change", () => this.showProjectTimeline(select.value));
    if (this.calProject) {
      const clear = filterRow.createEl("button", { cls: "dh-btn dh-btn-icon-only", attr: { "aria-label": "显示全部" } });
      setIcon(clear, "x");
      clear.addEventListener("click", () => this.showProjectTimeline(""));
    }
    card.toggleClass("is-filtered", Boolean(this.calProject));

    const head = card.createDiv({ cls: "dh-cal-head" });
    const prev = head.createEl("button", { cls: "dh-btn dh-btn-icon-only", attr: { "aria-label": isWeek ? "上一周" : "上个月" } });
    setIcon(prev, "chevron-left");
    const title = head.createDiv({ cls: "dh-cal-title" });
    title.createSpan({ cls: "dh-cal-year", text: `${ref.getFullYear()}` });
    title.createSpan({ cls: "dh-cal-month", text: `${ref.getMonth() + 1} 月` });
    const next = head.createEl("button", { cls: "dh-btn dh-btn-icon-only", attr: { "aria-label": isWeek ? "下一周" : "下个月" } });
    setIcon(next, "chevron-right");
    const mode = head.createEl("button", {
      cls: "dh-btn dh-btn-soft dh-cal-mode",
      attr: { "aria-label": isWeek ? "展开为月视图" : "收起为周视图" },
    });
    setIcon(mode.createSpan({ cls: "dh-btn-icon" }), isWeek ? "chevrons-up-down" : "chevrons-down-up");
    mode.createSpan({ cls: "dh-btn-label", text: isWeek ? "月" : "周" });

    prev.addEventListener("click", () => this.shiftCalendar(-1));
    next.addEventListener("click", () => this.shiftCalendar(1));
    mode.addEventListener("click", () => {
      this.calMode = isWeek ? "month" : "week";
      this.visibleMonth = monthStart(sel);
      this.renderCalendar();
    });

    const grid = card.createDiv({ cls: `dh-cal-grid ${isWeek ? "is-week" : "is-month"}` });
    for (const w of WEEKDAYS) grid.createDiv({ cls: "dh-cal-weekday", text: w });

    const todayKey = keyOf(new Date());
    const addDay = (d, outside) => {
      const k = keyOf(d);
      const count = this.countOf(k);
      const btn = grid.createEl("button", {
        cls: "dh-cal-day",
        attr: { "aria-label": count ? `${k}，${count} 篇笔记` : `${k}，无笔记` },
      });
      btn.createSpan({ cls: "dh-cal-num", text: String(d.getDate()) });
      const dots = btn.createSpan({ cls: "dh-cal-dots" });
      for (let i = 0; i < Math.min(count, 3); i += 1) dots.createSpan({ cls: "dh-cal-dot" });
      if (count) btn.addClass(this.calProject ? "heat-3" : `heat-${Math.min(count, 4)}`);
      btn.toggleClass("is-outside", outside);
      btn.toggleClass("is-today", k === todayKey);
      btn.toggleClass("is-selected", k === this.selectedDate);
      btn.toggleClass("is-weekend", d.getDay() === 0 || d.getDay() === 6);
      btn.addEventListener("click", () => this.selectDate(k));
    };

    if (isWeek) {
      const start = weekStart(sel);
      for (let i = 0; i < 7; i += 1) addDay(addDays(start, i), false);
    } else {
      const first = this.visibleMonth;
      const lead = (first.getDay() + 6) % 7;
      const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
      for (let i = lead; i > 0; i -= 1) addDay(addDays(first, -i), true);
      for (let i = 0; i < days; i += 1) addDay(addDays(first, i), false);
      const trailing = (7 - ((lead + days) % 7)) % 7;
      const last = addDays(first, days - 1);
      for (let i = 1; i <= trailing; i += 1) addDay(addDays(last, i), true);
    }

    if (!this.calProject) {
      const legend = card.createDiv({ cls: "dh-cal-legend" });
      legend.createSpan({ text: "少" });
      for (let i = 0; i <= 4; i += 1) legend.createSpan({ cls: `dh-legend-swatch heat-${i}` });
      legend.createSpan({ text: "多" });
    } else {
      this.renderTimeline(card);
    }

    let startX = null;
    let startY = null;
    grid.addEventListener("touchstart", (e) => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    }, { passive: true });
    grid.addEventListener("touchend", (e) => {
      if (startX === null) return;
      const dx = e.changedTouches[0].clientX - startX;
      const dy = e.changedTouches[0].clientY - startY;
      startX = null;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) this.shiftCalendar(dx < 0 ? 1 : -1);
    }, { passive: true });
  }

  renderTimeline(card) {
    const dates = this.projectDates(this.calProject);
    const wrap = card.createDiv({ cls: "dh-timeline" });
    const head = wrap.createDiv({ cls: "dh-timeline-head" });
    head.createDiv({ cls: "dh-timeline-title", text: `${this.labelForFolder(this.calProject)} · 时间线` });
    if (!dates.length) {
      wrap.createDiv({ cls: "dh-muted", text: "这个项目还没有日期笔记。" });
      return;
    }
    head.createDiv({
      cls: "dh-muted",
      text: `共 ${dates.length} 天 · ${dates[0]} 起 · 最近 ${dates.at(-1)}`,
    });
    const byMonth = new Map();
    for (const k of [...dates].reverse()) {
      const m = k.slice(0, 7);
      const list = byMonth.get(m) || [];
      list.push(k);
      byMonth.set(m, list);
    }
    const body = wrap.createDiv({ cls: "dh-timeline-body" });
    for (const [m, list] of byMonth) {
      const row = body.createDiv({ cls: "dh-timeline-month" });
      const [y, mm] = m.split("-");
      row.createDiv({ cls: "dh-timeline-label", text: `${y}.${mm}` });
      const chips = row.createDiv({ cls: "dh-timeline-dates" });
      for (const k of list) {
        const d = parseKey(k);
        const chip = chips.createEl("button", {
          cls: "dh-date-chip",
          text: String(d.getDate()),
          attr: { "aria-label": k, title: `${k} ${WEEKDAY_FULL[d.getDay()]}` },
        });
        chip.toggleClass("is-selected", k === this.selectedDate);
        chip.addEventListener("click", () => this.selectDate(k));
      }
    }
  }

  /* ----- launcher（今日内容） ----- */

  renderLauncher() {
    const card = this.els.launcher;
    if (!card) return;
    card.empty();
    card.toggleClass("is-managing", this.manage);
    const d = parseKey(this.selectedDate);
    const isToday = this.selectedDate === keyOf(new Date());

    const head = card.createDiv({ cls: "dh-card-head" });
    const h = head.createDiv();
    h.createEl("h2", { text: this.manage ? "管理项目" : isToday ? "今日内容" : "当日内容" });
    h.createDiv({
      cls: "dh-card-sub",
      text: this.manage
        ? "调整顺序（常用的往前）、存档不再使用的项目"
        : `创建或打开 ${d.getMonth() + 1} 月 ${d.getDate()} 日（${WEEKDAY_FULL[d.getDay()]}）的日期笔记`,
    });
    const actions = head.createDiv({ cls: "dh-head-actions" });
    const addBtn = actions.createEl("button", { cls: "dh-btn dh-btn-soft", attr: { "aria-label": "新建项目" } });
    setIcon(addBtn.createSpan({ cls: "dh-btn-icon" }), "folder-plus");
    addBtn.createSpan({ cls: "dh-btn-label", text: "新项目" });
    addBtn.addEventListener("click", () => new NewProjectModal(this.app, this.plugin).open());
    const manageBtn = actions.createEl("button", {
      cls: `dh-btn ${this.manage ? "dh-btn-primary" : "dh-btn-soft"}`,
      attr: { "aria-label": this.manage ? "完成" : "管理项目" },
    });
    setIcon(manageBtn.createSpan({ cls: "dh-btn-icon" }), this.manage ? "check" : "settings-2");
    manageBtn.createSpan({ cls: "dh-btn-label", text: this.manage ? "完成" : "管理" });
    manageBtn.addEventListener("click", () => {
      this.manage = !this.manage;
      this.renderLauncher();
    });

    const projects = this.projects();
    if (!projects.length) {
      card.createDiv({ cls: "dh-muted", text: `未找到“${this.s.dateRecordFolder}”或“${this.s.projectRoot}”目录` });
      return;
    }
    if (this.manage) this.renderManageList(card, projects);
    else this.renderLaunchChips(card, projects);
  }

  renderLaunchChips(card, projects) {
    const active = projects.filter((p) => !p.archived);
    const archived = projects.filter((p) => p.archived);
    const limit = this.s.launcherLimit > 0 ? this.s.launcherLimit : Infinity;
    const shown = this.launcherExpanded ? active : active.slice(0, limit);
    const hidden = active.length - shown.length;

    const wrap = card.createDiv({ cls: "dh-chip-row dh-launch-row" });
    for (const p of shown) this.launchChip(wrap, p);

    if (hidden > 0 || (this.launcherExpanded && active.length > limit)) {
      const more = wrap.createEl("button", { cls: "dh-launch dh-launch-more" });
      setIcon(more.createSpan({ cls: "dh-launch-icon" }), this.launcherExpanded ? "chevron-up" : "more-horizontal");
      more.createSpan({ cls: "dh-launch-label", text: this.launcherExpanded ? "收起" : `更多 ${hidden}` });
      more.addEventListener("click", () => {
        this.launcherExpanded = !this.launcherExpanded;
        this.renderLauncher();
      });
    }

    if (archived.length) {
      const toggle = card.createEl("button", { cls: "dh-archive-toggle" });
      setIcon(toggle.createSpan({ cls: "dh-btn-icon" }), this.showArchived ? "chevron-down" : "chevron-right");
      toggle.createSpan({ text: `已存档 ${archived.length}` });
      toggle.addEventListener("click", () => {
        this.showArchived = !this.showArchived;
        this.renderLauncher();
      });
      if (this.showArchived) {
        const arch = card.createDiv({ cls: "dh-chip-row dh-launch-row is-archived" });
        for (const p of archived) this.launchChip(arch, p);
      }
    }
  }

  launchChip(wrap, p) {
    const path = normalizePath(`${p.path}/${this.selectedDate}.md`);
    const existing = this.app.vault.getAbstractFileByPath(path);
    const btn = wrap.createEl("button", {
      cls: "dh-launch",
      attr: { title: path, "aria-label": `${existing ? "打开" : "创建"} ${p.label}` },
    });
    btn.toggleClass("is-done", Boolean(existing));
    btn.toggleClass("is-primary", p.isRecord);
    btn.toggleClass("is-archived", p.archived);
    setIcon(btn.createSpan({ cls: "dh-launch-icon" }), existing ? "check" : "plus");
    btn.createSpan({ cls: "dh-launch-label", text: p.label });
    btn.addEventListener("click", async (evt) => {
      if (btn.hasClass("is-busy")) return;
      btn.addClass("is-busy");
      try {
        let file = this.app.vault.getAbstractFileByPath(path);
        if (!file) file = await this.app.vault.create(path, "");
        await this.openFile(file, evt);
      } catch (err) {
        console.error("[daily-hub] launch failed", err);
        new Notice(`无法打开或创建：${path}`);
      } finally {
        btn.removeClass("is-busy");
      }
    });
  }

  renderManageList(card, projects) {
    const tools = card.createDiv({ cls: "dh-manage-tools" });
    const freq = tools.createEl("button", { cls: "dh-btn dh-btn-soft" });
    setIcon(freq.createSpan({ cls: "dh-btn-icon" }), "bar-chart-3");
    freq.createSpan({ cls: "dh-btn-label", text: "按近 30 天使用频率排序" });
    freq.addEventListener("click", () => this.plugin.sortByFrequency(this.filesByDate));

    const counts = new Map();
    for (const files of this.filesByDate.values()) {
      for (const f of files) {
        const k = f.parent?.path || "";
        counts.set(k, (counts.get(k) || 0) + 1);
      }
    }

    const list = card.createDiv({ cls: "dh-manage-list" });
    const movable = projects.filter((p) => !p.isRecord);
    const renderRow = (p) => {
      const row = list.createDiv({ cls: "dh-manage-row" });
      row.toggleClass("is-archived", p.archived);
      row.toggleClass("is-record", p.isRecord);
      const info = row.createDiv({ cls: "dh-manage-info" });
      info.createDiv({ cls: "dh-manage-name", text: p.label });
      info.createDiv({
        cls: "dh-manage-meta",
        text: `${counts.get(p.path) || 0} 篇${p.isRecord ? " · 固定在最前" : ""}${p.archived ? " · 已存档" : ""}`,
      });
      const btns = row.createDiv({ cls: "dh-manage-btns" });
      const iconBtn = (icon, label, fn, disabled = false) => {
        const b = btns.createEl("button", { cls: "dh-btn dh-btn-icon-only", attr: { "aria-label": label, title: label } });
        setIcon(b, icon);
        b.disabled = disabled;
        b.addEventListener("click", fn);
        return b;
      };
      iconBtn("history", "查看时间线", () => {
        this.manage = false;
        this.renderLauncher();
        this.showProjectTimeline(p.path);
      });
      if (p.isRecord) return;
      const idx = movable.indexOf(p);
      iconBtn("arrow-up-to-line", "置顶", () => this.plugin.moveProject(p.path, "top"), idx === 0);
      iconBtn("chevron-up", "上移", () => this.plugin.moveProject(p.path, -1), idx === 0);
      iconBtn("chevron-down", "下移", () => this.plugin.moveProject(p.path, 1), idx === movable.length - 1);
      const arch = iconBtn(p.archived ? "archive-restore" : "archive", p.archived ? "取消存档" : "存档", () =>
        this.plugin.toggleArchive(p.path)
      );
      arch.addClass(p.archived ? "is-restore" : "is-archive");
    };
    for (const p of projects.filter((x) => !x.archived)) renderRow(p);
    const archived = projects.filter((x) => x.archived);
    if (archived.length) {
      list.createDiv({ cls: "dh-manage-section", text: "已存档（不在今日内容中显示，但历史笔记照常显示）" });
      for (const p of archived) renderRow(p);
    }
  }

  /* ----- memo ----- */

  renderMemo() {
    const card = this.els.memo;
    if (!card) return;
    card.empty();
    const memo = (this.s.memo || "").trim();
    card.toggleClass("is-hidden", !this.s.showMemo || !memo);
    if (!this.s.showMemo || !memo) return;
    this.disposeComponent("memoComponent");
    this.memoComponent = this.addChild(new Component());

    const head = card.createDiv({ cls: "dh-card-head" });
    const h = head.createDiv({ cls: "dh-memo-title" });
    setIcon(h.createSpan({ cls: "dh-memo-icon" }), "quote");
    h.createEl("h2", { text: "写给自己" });
    const edit = head.createEl("button", { cls: "dh-btn dh-btn-icon-only", attr: { "aria-label": "编辑（插件设置）" } });
    setIcon(edit, "pencil");
    edit.addEventListener("click", () => this.plugin.openSettings());

    const body = card.createDiv({ cls: "dh-memo-body markdown-rendered" });
    MarkdownRenderer.render(this.app, memo, body, "", this.memoComponent);
    this.bindLinks(body, "");
  }

  /* ----- day: filters + notes ----- */

  recordFileFor(key) {
    const path = normalizePath(`${this.s.dateRecordFolder}/${key}.md`);
    return this.app.vault.getAbstractFileByPath(path);
  }

  renderDay() {
    const el = this.els.day;
    if (!el) return;
    el.empty();
    const files = this.filesByDate.get(this.selectedDate) || [];
    const groups = this.groupFiles(files);
    const sel = this.selectionFor(this.selectedDate, groups);
    const d = parseKey(this.selectedDate);

    const head = el.createDiv({ cls: "dh-day-head" });
    const h = head.createDiv();
    h.createEl("h2", { text: `${d.getMonth() + 1} 月 ${d.getDate()} 日` });
    h.createDiv({ cls: "dh-card-sub", text: `${WEEKDAY_FULL[d.getDay()]} · ${files.length} 篇笔记` });
    const right = head.createDiv({ cls: "dh-day-actions" });
    const record = this.recordFileFor(this.selectedDate);
    if (record) {
      const ai = right.createEl("button", {
        cls: "dh-btn dh-btn-ai",
        attr: { "aria-label": "AI 识别日常记录中属于其他项目的内容" },
      });
      setIcon(ai.createSpan({ cls: "dh-btn-icon" }), this.aiBusy ? "loader" : "sparkles");
      ai.createSpan({ cls: "dh-btn-label", text: this.aiBusy ? "识别中…" : "AI 整理到项目" });
      ai.toggleClass("is-busy", this.aiBusy);
      ai.addEventListener("click", () => this.runAi(record));
    }
    this.els.dayCount = right.createDiv({ cls: "dh-pill" });

    this.els.filters = el.createDiv({ cls: "dh-chip-row dh-filter-row" });
    this.els.notes = el.createDiv({ cls: "dh-notes" });

    if (groups.size > 1) {
      const all = this.els.filters.createEl("button", { cls: "dh-chip", text: "全部" });
      all.toggleClass("is-active", groups.size === sel.size);
      all.addEventListener("click", () => {
        if (sel.size === groups.size) sel.clear();
        else for (const k of groups.keys()) sel.add(k);
        this.renderDay();
      });
    }
    if (groups.size > 0) {
      for (const [path, g] of groups) {
        const chip = this.els.filters.createEl("button", { cls: "dh-chip" });
        chip.createSpan({ text: g.label });
        chip.createSpan({ cls: "dh-chip-count", text: String(g.files.length) });
        chip.toggleClass("is-active", sel.has(path));
        chip.addEventListener("click", () => {
          if (sel.has(path)) sel.delete(path);
          else sel.add(path);
          this.renderDay();
        });
      }
    } else {
      this.els.filters.remove();
    }

    this.renderNotes(groups, sel, files.length);
  }

  async renderNotes(groups, sel, totalCount) {
    const token = ++this.notesToken;
    this.disposeComponent("notesComponent");
    const component = this.addChild(new Component());
    this.notesComponent = component;
    const container = this.els.notes;
    container.empty();

    const visible = [...groups.entries()].filter(([path]) => sel.has(path));
    const visibleCount = visible.reduce((n, [, g]) => n + g.files.length, 0);
    this.els.dayCount.setText(`${visibleCount} / ${totalCount}`);

    if (!totalCount) {
      this.emptyState(container, "calendar-plus", "这一天还没有日期笔记", "点击上方「今日内容」中的分类即可创建");
      return;
    }
    if (!visible.length) {
      this.emptyState(container, "filter", "没有选中的分类", "点上方的标签来选择要查看的内容");
      return;
    }

    for (const [path, g] of visible) {
      const group = container.createEl("section", { cls: "dh-group" });
      group.toggleClass("is-record", path === normalizePath(this.s.dateRecordFolder));
      const gh = group.createDiv({ cls: "dh-group-head" });
      setIcon(gh.createSpan({ cls: "dh-group-icon" }), path === normalizePath(this.s.dateRecordFolder) ? "notebook-pen" : "folder");
      gh.createEl("h3", { text: g.label });
      gh.createSpan({ cls: "dh-group-count", text: `${g.files.length}` });
      if (this.projectByPath(path)?.archived) gh.createSpan({ cls: "dh-tag", text: "已存档" });
      const tl = gh.createEl("button", { cls: "dh-btn dh-btn-icon-only dh-group-tl", attr: { "aria-label": "查看该项目时间线" } });
      setIcon(tl, "history");
      tl.addEventListener("click", () => this.showProjectTimeline(path));

      for (const file of g.files) {
        if (token !== this.notesToken) return;
        const card = group.createEl("article", { cls: "dh-note" });
        const nh = card.createDiv({ cls: "dh-note-head" });
        const toggle = nh.createEl("button", { cls: "dh-note-toggle", attr: { "aria-label": "折叠/展开" } });
        setIcon(toggle, "chevron-down");
        const pth = nh.createDiv({ cls: "dh-note-path", text: file.parent?.path || "/" });
        pth.setAttr("title", file.path);
        const open = nh.createEl("button", { cls: "dh-btn dh-btn-soft dh-note-open", attr: { "aria-label": "打开原文" } });
        setIcon(open.createSpan({ cls: "dh-btn-icon" }), "external-link");
        open.createSpan({ cls: "dh-btn-label", text: "打开" });
        open.addEventListener("click", (evt) => {
          this.openFile(file, evt).catch((err) => {
            console.error("[daily-hub] open failed", err);
            new Notice(`无法打开：${file.path}`);
          });
        });
        const flip = () => card.toggleClass("is-collapsed", !card.hasClass("is-collapsed"));
        toggle.addEventListener("click", flip);
        pth.addEventListener("click", flip);

        const body = card.createDiv({ cls: "dh-note-body markdown-rendered" });
        const md = await this.app.vault.cachedRead(file);
        if (token !== this.notesToken) return;
        if (!md.trim()) {
          body.createDiv({ cls: "dh-muted", text: "笔记为空" });
          continue;
        }
        await MarkdownRenderer.render(this.app, md, body, file.path, component);
        if (token !== this.notesToken) return;
        this.bindLinks(body, file.path);

        if (this.s.clampLongNotes) {
          window.requestAnimationFrame(() => {
            if (body.scrollHeight <= 460) return;
            card.addClass("is-clamped");
            const more = card.createEl("button", { cls: "dh-note-more", text: "展开全文" });
            more.addEventListener("click", () => {
              const clamped = card.hasClass("is-clamped");
              card.toggleClass("is-clamped", !clamped);
              more.setText(clamped ? "收起" : "展开全文");
            });
          });
        }
      }
    }
  }

  /* ----- AI ----- */

  async runAi(recordFile) {
    if (this.aiBusy) return;
    if (!this.s.aiApiKey) {
      new Notice("请先在 Daily Hub 设置里填写 AI 接口的 API Key");
      this.plugin.openSettings();
      return;
    }
    this.aiBusy = true;
    this.renderDay();
    const date = this.selectedDate;
    try {
      const items = await this.plugin.analyzeDay(date, recordFile);
      if (!items.length) {
        new Notice("没有发现属于其他项目的内容");
        return;
      }
      new AiReviewModal(this.app, this.plugin, date, recordFile, items).open();
    } catch (err) {
      console.error("[daily-hub] AI failed", err);
      new Notice(`AI 识别失败：${err.message || err}`, 8000);
    } finally {
      this.aiBusy = false;
      this.renderDay();
    }
  }

  bindLinks(el, sourcePath) {
    el.addEventListener("click", (evt) => {
      const a = evt.target.closest?.("a.internal-link");
      if (!a) return;
      evt.preventDefault();
      const href = a.getAttr("data-href") || a.getAttr("href");
      if (href) this.app.workspace.openLinkText(href, sourcePath, Keymap.isModEvent(evt));
    });
  }

  emptyState(container, icon, title, desc) {
    const e = container.createDiv({ cls: "dh-empty" });
    setIcon(e.createDiv({ cls: "dh-empty-icon" }), icon);
    e.createDiv({ cls: "dh-empty-title", text: title });
    e.createDiv({ cls: "dh-empty-desc", text: desc });
  }
}

/* ---------- modals ---------- */

class NewProjectModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    this.modalEl.addClass("dh-modal");
    this.setTitle?.("新建项目");
    if (!this.setTitle) contentEl.createEl("h3", { text: "新建项目" });
    contentEl.createDiv({
      cls: "dh-muted",
      text: `会在「${this.plugin.settings.projectRoot}」下新建文件夹。可用 / 建子项目，例如：论文/新方向`,
    });
    const input = contentEl.createEl("input", { cls: "dh-input", attr: { type: "text", placeholder: "项目名称" } });
    const row = contentEl.createDiv({ cls: "dh-modal-actions" });
    const cancel = row.createEl("button", { text: "取消" });
    const ok = row.createEl("button", { cls: "mod-cta", text: "创建" });
    cancel.addEventListener("click", () => this.close());
    const submit = async () => {
      const name = input.value.trim().replace(/^\/+|\/+$/g, "");
      if (!name) return;
      if (/[\\:*?"<>|]/.test(name)) {
        new Notice("名称里不能包含 \\ : * ? \" < > |");
        return;
      }
      try {
        await this.plugin.createProject(name);
        this.close();
      } catch (err) {
        new Notice(`创建失败：${err.message || err}`);
      }
    };
    ok.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) submit();
    });
    window.setTimeout(() => input.focus(), 50);
  }

  onClose() {
    this.contentEl.empty();
  }
}

class AiReviewModal extends Modal {
  constructor(app, plugin, date, recordFile, items) {
    super(app);
    this.plugin = plugin;
    this.date = date;
    this.recordFile = recordFile;
    this.items = items.map((it) => ({ ...it, checked: true }));
  }

  onOpen() {
    const { contentEl } = this;
    this.modalEl.addClass("dh-modal", "dh-ai-modal");
    const title = `AI 识别结果 · ${shortDate(this.date)}`;
    if (this.setTitle) this.setTitle(title);
    else contentEl.createEl("h3", { text: title });
    contentEl.createDiv({
      cls: "dh-muted",
      text: "勾选要写入的条目，可以改项目和内容。日常记录不会被修改；同一天重复运行会替换之前 AI 写入的那一段。",
    });

    const projects = this.plugin.getProjects().filter((p) => !p.isRecord);
    const list = contentEl.createDiv({ cls: "dh-ai-list" });
    for (const it of this.items) {
      const row = list.createDiv({ cls: "dh-ai-item" });
      const top = row.createDiv({ cls: "dh-ai-item-top" });
      const cb = top.createEl("input", { attr: { type: "checkbox" } });
      cb.checked = it.checked;
      cb.addEventListener("change", () => {
        it.checked = cb.checked;
        row.toggleClass("is-off", !cb.checked);
      });
      const sel = top.createEl("select", { cls: "dropdown" });
      for (const p of projects) {
        sel.createEl("option", { text: p.archived ? `${p.label}（已存档）` : p.label, attr: { value: p.path } });
      }
      sel.value = it.path;
      const status = top.createSpan({ cls: "dh-ai-status" });
      const updateStatus = () => {
        const exists = this.app.vault.getAbstractFileByPath(normalizePath(`${it.path}/${this.date}.md`));
        status.setText(exists ? "追加到已有笔记" : "新建笔记");
      };
      updateStatus();
      sel.addEventListener("change", () => {
        it.path = sel.value;
        updateStatus();
      });
      const ta = row.createEl("textarea", { cls: "dh-ai-text" });
      ta.value = it.summary;
      ta.rows = Math.min(8, Math.max(3, it.summary.split("\n").length + 1));
      ta.addEventListener("input", () => (it.summary = ta.value));
      if (it.reason) row.createDiv({ cls: "dh-ai-reason", text: `依据：${it.reason}` });
    }

    const actions = contentEl.createDiv({ cls: "dh-modal-actions" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    const ok = actions.createEl("button", { cls: "mod-cta", text: "写入所选项目" });
    ok.addEventListener("click", async () => {
      const chosen = this.items.filter((it) => it.checked && it.summary.trim());
      if (!chosen.length) {
        this.close();
        return;
      }
      ok.disabled = true;
      try {
        const n = await this.plugin.writeAiItems(this.date, this.recordFile, chosen);
        new Notice(`已写入 ${n} 个项目`);
        this.close();
      } catch (err) {
        console.error("[daily-hub] write failed", err);
        new Notice(`写入失败：${err.message || err}`);
        ok.disabled = false;
      }
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

/* ---------- settings ---------- */

class DailyHubSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = async () => this.plugin.saveSettings();
    const text = (name, desc, key, placeholder = "") =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((t) =>
          t.setPlaceholder(placeholder).setValue(s[key]).onChange(async (v) => {
            s[key] = v.trim();
            await save();
          })
        );
    const toggle = (name, desc, key) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addToggle((t) =>
          t.setValue(s[key]).onChange(async (v) => {
            s[key] = v;
            await save();
          })
        );

    new Setting(containerEl).setName("基础").setHeading();
    text("主页标题", "", "title");
    text("日期记录目录", "「今日内容」里固定排在最前的分类，当天内容也优先显示它。", "dateRecordFolder");
    text("项目根目录", "该目录下的子目录会作为项目。", "projectRoot");
    new Setting(containerEl)
      .setName("忽略的文件夹名")
      .setDesc("这些名字的文件夹不算项目，用逗号分隔。")
      .addText((t) =>
        t.setValue(s.ignoredFolderNames.join(", ")).onChange(async (v) => {
          s.ignoredFolderNames = v.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
          await save();
        })
      );
    new Setting(containerEl)
      .setName("今日内容默认显示数量")
      .setDesc("超过的项目收进「更多」。0 表示全部显示。顺序在主页的「管理」里调整。")
      .addSlider((sl) =>
        sl.setLimits(0, 30, 1).setDynamicTooltip().setValue(s.launcherLimit).onChange(async (v) => {
          s.launcherLimit = v;
          await save();
        })
      );
    new Setting(containerEl)
      .setName("排除的目录")
      .setDesc("每行一个路径前缀，其中的日期笔记不会显示。")
      .addTextArea((t) => {
        t.inputEl.rows = 4;
        t.setValue(s.excludedFolderPrefixes.join("\n")).onChange(async (v) => {
          s.excludedFolderPrefixes = v.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
          await save();
        });
      });

    new Setting(containerEl).setName("AI 识别").setHeading();
    containerEl.createDiv({
      cls: "setting-item-description",
      text: "使用 OpenAI 兼容接口（默认 DeepSeek）。注意：API Key 保存在本插件的 data.json 中，会随库一起同步。",
    });
    text("接口地址", "例如 https://api.deepseek.com 或 https://api.openai.com/v1", "aiBaseUrl", "https://api.deepseek.com");
    new Setting(containerEl).setName("API Key").addText((t) => {
      t.inputEl.type = "password";
      t.setPlaceholder("sk-...").setValue(s.aiApiKey).onChange(async (v) => {
        s.aiApiKey = v.trim();
        await save();
      });
    });
    text("模型", "DeepSeek 用 deepseek-chat 即可。", "aiModel", "deepseek-chat");
    new Setting(containerEl)
      .setName("项目说明")
      .setDesc("可选，每行「项目名: 说明」，帮助 AI 更准确地判断归属。例如：记账: 花钱、收入、价格")
      .addTextArea((t) => {
        t.inputEl.rows = 6;
        t.inputEl.style.width = "100%";
        t.setValue(s.projectHints).onChange(async (v) => {
          s.projectHints = v;
          await save();
        });
      });
    new Setting(containerEl)
      .setName("额外要求")
      .setDesc("可选，补充给 AI 的整理要求。")
      .addTextArea((t) => {
        t.inputEl.rows = 3;
        t.inputEl.style.width = "100%";
        t.setValue(s.aiExtraPrompt).onChange(async (v) => {
          s.aiExtraPrompt = v;
          await save();
        });
      });

    new Setting(containerEl).setName("显示").setHeading();
    toggle("显示「写给自己」卡片", "", "showMemo");
    new Setting(containerEl)
      .setName("「写给自己」内容")
      .setDesc("支持 Markdown。")
      .addTextArea((t) => {
        t.inputEl.rows = 8;
        t.inputEl.style.width = "100%";
        t.setValue(s.memo).onChange(async (v) => {
          s.memo = v;
          await save();
        });
      });
    toggle("长笔记折叠", "超过一定高度的笔记先显示一部分。", "clampLongNotes");
    toggle("手机默认周视图", "在手机上打开时，日历默认收起为一周。", "phoneWeekView");
    toggle("启动时打开主页", "", "openOnStartup");
    toggle("新标签页显示主页", "打开空白标签页时自动显示主页。", "replaceNewTabs");
  }
}

/* ---------- plugin ---------- */

module.exports = class DailyHubPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.registerView(VIEW_TYPE, (leaf) => new DailyHubView(leaf, this));
    this.addRibbonIcon("layout-dashboard", "打开主页", () => this.activateView());
    this.addCommand({ id: "open", name: "打开主页", callback: () => this.activateView() });
    this.addCommand({
      id: "ai-today",
      name: "AI 整理今天的日常记录到项目",
      callback: async () => {
        await this.activateView();
        const view = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]?.view;
        if (!(view instanceof DailyHubView)) return;
        view.selectDate(keyOf(new Date()));
        const record = view.recordFileFor(view.selectedDate);
        if (record) view.runAi(record);
        else new Notice("今天还没有日常记录");
      },
    });
    this.addSettingTab(new DailyHubSettingTab(this.app, this));

    let timer = null;
    const schedule = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        this.forEachView((v) => v.refresh());
      }, 400);
    };
    this.register(() => timer && window.clearTimeout(timer));
    const relevant = (file, oldPath) =>
      isFolder(file) ||
      DATE_NAME_PATTERN.test(file?.basename || "") ||
      (oldPath && DATE_NAME_PATTERN.test(oldPath.split("/").pop().replace(/\.md$/, "")));
    this.registerEvent(this.app.vault.on("create", (f) => relevant(f) && schedule()));
    this.registerEvent(this.app.vault.on("delete", (f) => relevant(f) && schedule()));
    this.registerEvent(this.app.vault.on("rename", (f, old) => relevant(f, old) && schedule()));
    this.registerEvent(
      this.app.vault.on("modify", (f) => {
        if (!DATE_NAME_PATTERN.test(f?.basename || "")) return;
        let shown = false;
        this.forEachView((v) => (shown = shown || v.selectedDate === f.basename));
        if (shown) schedule();
      })
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf && this.settings.replaceNewTabs && leaf.getViewState().type === "empty") {
          leaf.setViewState({ type: VIEW_TYPE, active: true });
        }
      })
    );
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.openOnStartup) this.activateView();
    });
  }

  onunload() {}

  forEachView(fn) {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof DailyHubView) fn(leaf.view);
    }
  }

  openSettings() {
    const setting = this.app.setting;
    if (setting?.open) {
      setting.open();
      setting.openTabById?.(this.manifest.id);
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) || {});
    for (const k of ["excludedFolderPrefixes", "projectOrder", "archivedProjects", "ignoredFolderNames"]) {
      if (!Array.isArray(this.settings[k])) this.settings[k] = [...DEFAULT_SETTINGS[k]];
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.forEachView((v) => {
      v.buildIndex();
      v.renderAll();
    });
  }

  /* ----- projects ----- */

  getProjects() {
    const s = this.settings;
    const vault = this.app.vault;
    const out = [];
    const record = vault.getAbstractFileByPath(normalizePath(s.dateRecordFolder));
    if (isFolder(record)) {
      out.push({ path: record.path, label: record.name, isRecord: true, archived: false });
    }
    const root = vault.getAbstractFileByPath(normalizePath(s.projectRoot));
    if (!isFolder(root)) return out;
    const ignored = new Set(s.ignoredFolderNames);
    const archived = new Set(s.archivedProjects);
    const order = new Map(s.projectOrder.map((p, i) => [p, i]));
    const list = collectProjectTargets(root, root.path, ignored).map((folder) => ({
      path: folder.path,
      label: folder.path.slice(root.path.length + 1).split("/").join(" / "),
      isRecord: false,
      archived: archived.has(folder.path),
    }));
    list.sort((a, b) => {
      const ia = order.has(a.path) ? order.get(a.path) : Infinity;
      const ib = order.has(b.path) ? order.get(b.path) : Infinity;
      if (ia !== ib) return ia - ib;
      return a.label.localeCompare(b.label, "zh-CN");
    });
    return out.concat(list);
  }

  currentOrder() {
    return this.getProjects().filter((p) => !p.isRecord).map((p) => p.path);
  }

  async moveProject(path, delta) {
    const order = this.currentOrder();
    const i = order.indexOf(path);
    if (i === -1) return;
    order.splice(i, 1);
    if (delta === "top") order.unshift(path);
    else order.splice(Math.max(0, Math.min(order.length, i + delta)), 0, path);
    this.settings.projectOrder = order;
    await this.saveSettings();
  }

  async toggleArchive(path) {
    const set = new Set(this.settings.archivedProjects);
    if (set.has(path)) set.delete(path);
    else set.add(path);
    this.settings.archivedProjects = [...set];
    await this.saveSettings();
  }

  async sortByFrequency(filesByDate) {
    const since = keyOf(addDays(new Date(), -30));
    const counts = new Map();
    for (const [k, files] of filesByDate) {
      if (k < since) continue;
      for (const f of files) {
        const p = f.parent?.path || "";
        counts.set(p, (counts.get(p) || 0) + 1);
      }
    }
    const order = this.currentOrder();
    const pos = new Map(order.map((p, i) => [p, i]));
    order.sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0) || pos.get(a) - pos.get(b));
    this.settings.projectOrder = order;
    await this.saveSettings();
    new Notice("已按近 30 天的笔记数量重新排序");
  }

  async createProject(name) {
    const path = normalizePath(`${this.settings.projectRoot}/${name}`);
    if (this.app.vault.getAbstractFileByPath(path)) throw new Error("同名项目已存在");
    await this.app.vault.createFolder(path);
    this.settings.projectOrder = [...this.currentOrder().filter((p) => p !== path), path];
    await this.saveSettings();
    new Notice(`已创建项目：${name}`);
  }

  /* ----- AI ----- */

  async analyzeDay(date, recordFile) {
    const s = this.settings;
    const daily = (await this.app.vault.cachedRead(recordFile)).trim();
    if (!daily) return [];
    const projects = this.getProjects().filter((p) => !p.isRecord && !p.archived);
    if (!projects.length) return [];

    const hints = new Map();
    for (const line of (s.projectHints || "").split(/\r?\n/)) {
      const m = line.match(/^\s*(.+?)\s*[:：]\s*(.+)$/);
      if (m) hints.set(m[1].trim(), m[2].trim());
    }
    const projectLines = projects.map((p) => {
      const h = hints.get(p.label) || hints.get(p.label.replace(/ \/ /g, "/"));
      return `- ${p.label}${h ? `：${h}` : ""}`;
    });

    const existing = [];
    for (const p of projects) {
      const f = this.app.vault.getAbstractFileByPath(normalizePath(`${p.path}/${date}.md`));
      if (!f || !("extension" in f)) continue;
      const txt = stripAiBlock(await this.app.vault.cachedRead(f)).trim();
      if (txt) existing.push(`### ${p.label}\n${txt.slice(0, 800)}`);
    }

    const system = [
      "你是个人笔记整理助手。用户每天主要写「日常记录」，里面常常夹带属于其他项目的内容。",
      "任务：找出日常记录中属于给定项目的内容，按项目归类，为每个项目写简短摘要。",
      "规则：",
      "1. project 必须与项目列表中的名称完全一致，不能编造新项目。",
      "2. 摘要用中文 Markdown 无序列表，每个项目 1-5 条，每条尽量不超过 40 字，保留关键数字、名称、时间和结论。",
      "3. 只归类有明确依据的内容；不确定、或是无法归入任何项目的普通生活流水，一律忽略。",
      "4. 如果该项目当天已有笔记且已经记录了相同信息，不要重复输出。",
      "5. 只输出 JSON：{\"items\":[{\"project\":\"项目名\",\"summary\":\"- 要点\\n- 要点\",\"reason\":\"一句话说明依据\"}]}，没有则输出 {\"items\":[]}。",
      s.aiExtraPrompt ? `补充要求：${s.aiExtraPrompt}` : "",
    ].filter(Boolean).join("\n");

    const user = [
      `日期：${date}`,
      "",
      "【项目列表】",
      ...projectLines,
      "",
      existing.length ? "【这些项目当天已有的内容（不要重复）】\n" + existing.join("\n\n") : "【这些项目当天均无笔记】",
      "",
      "【日常记录】",
      daily.slice(0, 12000),
    ].join("\n");

    const base = (s.aiBaseUrl || DEFAULT_SETTINGS.aiBaseUrl).replace(/\/+$/, "");
    const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
    const res = await requestUrl({
      url,
      method: "POST",
      throw: false,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.aiApiKey}` },
      body: JSON.stringify({
        model: s.aiModel || DEFAULT_SETTINGS.aiModel,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (res.status >= 400) {
      let msg = "";
      try {
        msg = res.json?.error?.message || "";
      } catch (e) {
        msg = "";
      }
      throw new Error(`接口返回 ${res.status}${msg ? `：${msg}` : ""}`);
    }
    const content = res.json?.choices?.[0]?.message?.content || "";
    const parsed = parseJsonLoose(content);
    const byLabel = new Map(projects.map((p) => [p.label, p]));
    const byLoose = new Map(projects.map((p) => [p.label.replace(/\s/g, ""), p]));
    const merged = new Map();
    for (const it of Array.isArray(parsed?.items) ? parsed.items : []) {
      const name = String(it.project || "").trim();
      const p = byLabel.get(name) || byLoose.get(name.replace(/\s/g, ""));
      const summary = String(it.summary || "").trim();
      if (!p || !summary) continue;
      const prev = merged.get(p.path);
      if (prev) prev.summary += `\n${summary}`;
      else merged.set(p.path, { path: p.path, label: p.label, summary, reason: String(it.reason || "").trim() });
    }
    return [...merged.values()];
  }

  async writeAiItems(date, recordFile, items) {
    const link = this.app.fileManager.generateMarkdownLink
      ? this.app.fileManager.generateMarkdownLink(recordFile, "", "", "日常记录")
      : `[[${recordFile.path.replace(/\.md$/, "")}|日常记录]]`;
    let n = 0;
    for (const it of items) {
      const path = normalizePath(`${it.path}/${date}.md`);
      const block = `${AI_START}\n> [!abstract] 摘自${link}（AI 整理）\n${it.summary
        .trim()
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n")}\n${AI_END}`;
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!file) {
        await this.app.vault.create(path, `${block}\n`);
      } else {
        await this.app.vault.process(file, (text) => {
          const s = text.indexOf(AI_START);
          const e = text.indexOf(AI_END);
          if (s !== -1 && e > s) return text.slice(0, s) + block + text.slice(e + AI_END.length);
          const trimmed = text.replace(/\s+$/, "");
          return `${trimmed}${trimmed ? "\n\n" : ""}${block}\n`;
        });
      }
      n += 1;
    }
    return n;
  }

  async activateView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (existing) {
      this.app.workspace.revealLeaf(existing);
      return;
    }
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }
};

function parseJsonLoose(text) {
  const t = String(text).replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(t);
  } catch (e) {
    const s = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (s !== -1 && end > s) {
      try {
        return JSON.parse(t.slice(s, end + 1));
      } catch (e2) {
        /* fallthrough */
      }
    }
  }
  throw new Error("AI 返回的内容无法解析");
}
