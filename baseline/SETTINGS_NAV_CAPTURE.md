# claude.ai Settings dialog - nav capture

**Captured from:** a live Claude Desktop **v1.24012.9** session, 2026-07-29, light mode, desktop
window. Trimmed to the structurally relevant parts; **every class string is verbatim**.

This markup is served by the **remote claude.ai SPA**, not by the bundle we patch, so it can change
without a Claude Desktop release. It is the ground truth for:

- `js/extra_settings_page.js` - injects the "Extra" nav group into this dialog: **Themes**,
  **Community**, **Anthropic**, **Deployment**, in that order. The middle two are shortened
  because this column truncates; each carries its full name ("Community Features" /
  "Anthropic Features") as a `title` tooltip on the row and as its panel's `h1`
- `scripts/tests/core/test-extra-settings-dom.mjs` - its fixtures are built from the shape below

## The facts the injection depends on

1. **No per-group wrapper.** One scroll container holds a group **header `<div>`** and a group
   **`<ul>`** as plain **alternating siblings**. So our group is inserted as the same two siblings,
   immediately before the "Desktop app" header - never as a wrapper, and never inside a `<ul>`.
2. **Rows are `<li><button>`**, and a `<ul>` may only ever hold `<li>` children. Our rows are clones
   of a real `<li>`, and even the fail-soft rendering appends `<li>`s only.
3. **Icons are Anthropicons ICON-FONT spans** - `<span data-cds="Icon">` containing a private-use-area
   ligature character, `font-size: 20px` inline, `width/height: 1em`, `display: flex`. Not `<svg>`, not
   `<img>`. We keep that box, clear its ligature and put a `1em` `<svg>` inside it, so our glyph
   inherits the row's size and color. `data-cds="Icon"` is the anchor for anything icon-related.
4. **The label is its own span** (`min-w-0 flex-1 truncate`), the sibling of the icon box. It is found
   semantically: the element that is *not* the icon box and does not contain it. Text must never be
   written into the icon box - it would render through the icon font while the label span stays empty.
5. **Selection is `aria-current="page"` on the `<button>`** plus a class swap: selected
   `bg-alpha-2 font-medium text-primary`, unselected
   `text-secondary hover:bg-fill-ghost-hover hover:text-primary`. Both are migrated to our button on
   activate and given back on deactivate; the class diff is computed button-vs-button at runtime.
6. **One group ("Example Org") is a header followed by a bare `<a>`**, with no `<ul>` at all. Tolerate it,
   and keep it out of the selected-look diff - its class shape differs from a settings row's.
7. **The content pane is the dialog's second flex child**, and its **first** child is the header row
   carrying the close button. Only the `px-xl` scrolling body is taken over, so that button survives.

## What to re-check when it drifts

The installer writes one sanitized shape line to `~/.config/Claude/logs/claude-patches.log`
(`[ExtraSettings] nav shape rows=... box=... hdr[...]=... list=... item=... icon=... via=...`) - tag
names, class counts and our own tokens only, never page text. Read it first; it names the anchor that
was lost:

| Symptom in the log | What changed | Where to refit |
|---|---|---|
| `via=labels` on an English install | the test ids are gone | `ROW_TESTID_SEL`, `findNavByTestId()` |
| `hdr[#structure]` on an English install | group header text changed | `GROUP_LABELS` |
| `hdr[#last-group]` | the marked group is no longer followed by a header | `ROW_TESTID_SEL`, `findAnchor()` tier 2 |
| `hdr[-]=-` | group headers are no longer plain text siblings | `isGroupHeader()`, `findAnchor()` |
| `list=-` | rows are no longer in a `<ul>` | `cellFor()`, `fabricateGroup()` |
| `icon=svg` or `icon=none` | icon markup changed | `ICON_SEL`, `makeItem()` |
| `... no nav container could be identified` | rows are no longer controls | `CONTROL_SEL`, `controlFor()` |
| `no selected-row class diff` | selection marking changed | `SEL_ATTRS`, `findSelected()` |

`via` says how the nav itself was found and `hdr[...]` how the insertion anchor was found. Only a
tier-1 anchor is named by its label (`hdr[desktop app]`), because those labels are our own constants;
a structurally found header is named by its tier, since its text is the user's interface language and
page text never goes in this line. `via=testid` with `hdr[#structure]` is the normal, healthy line in
every language other than English.

Re-capture the nav (DevTools on the mainView, copy the `nav[aria-label="Settings"]` outer HTML plus the
content pane's first two levels), update this file, then refit the fixtures in
`scripts/tests/core/test-extra-settings-dom.mjs` against it.

## Capture

```html
<div id="_r_pd_" role="dialog" tabindex="-1" data-cds="Dialog" class="... fixed inset-0 m-auto flex ... rounded-card bg-surface-2 ..." aria-labelledby="base-ui-_r_pf_">
  <nav aria-label="Settings" class="flex w-48 shrink-0 flex-col gap-sm border-r border-alpha-2 bg-surface-1">
    <h2 id="base-ui-_r_pf_" class="text-title font-semibold text-primary sr-only">Settings</h2>
    <div class="shrink-0 px-md pt-md"><!-- search field, omitted --></div>

    <!-- THE SCROLL CONTAINER: group headers and <ul> lists ALTERNATE AS SIBLINGS here.
         There is NO per-group wrapper element. -->
    <div class="flex min-h-0 flex-1 flex-col gap-sm overflow-y-auto scroll-fade-y scroll-fade-size-6 px-md pb-md">

      <!-- group header (a plain sibling div) -->
      <div class="px-sm pt-md text-caption text-muted">Settings</div>

      <!-- group list -->
      <ul class="flex flex-col gap-px">
        <li data-testid="general-settings">
          <!-- SELECTED item: aria-current="page"; classes bg-alpha-2 font-medium text-primary -->
          <button type="button" aria-current="page" class="flex h-control w-full items-center gap-sm rounded px-sm text-left text-body transition-colors cursor-pointer bg-alpha-2 font-medium text-primary">
            <!-- ICON = Anthropicons ICON-FONT SPAN, NOT an <svg>. Its text content is a
                 private-use-area ligature character (invisible here). font-size 20px. -->
            <span data-cds="Icon" class="shrink-0 text-secondary" aria-hidden="true" style="font-family: var(--font-anthropicons, Anthropicons-Variable); font-feature-settings: &quot;liga&quot; 0; font-optical-sizing: auto; font-style: normal; font-variation-settings: normal; line-height: 1; width: 1em; height: 1em; display: flex; align-items: center; justify-content: center; flex-shrink: 0; user-select: none; font-size: 20px; font-weight: 433.3;">&#xE000;</span>
            <!-- LABEL span -->
            <span class="min-w-0 flex-1 truncate">General</span>
          </button>
        </li>
        <li data-testid="account-settings">
          <!-- UNSELECTED item: no aria-current; classes text-secondary hover:bg-fill-ghost-hover hover:text-primary -->
          <button type="button" class="flex h-control w-full items-center gap-sm rounded px-sm text-left text-body transition-colors cursor-pointer text-secondary hover:bg-fill-ghost-hover hover:text-primary">
            <span data-cds="Icon" class="shrink-0 text-secondary" aria-hidden="true" style="font-family: var(--font-anthropicons, Anthropicons-Variable); font-feature-settings: &quot;liga&quot; 0; line-height: 1; width: 1em; height: 1em; display: flex; align-items: center; justify-content: center; flex-shrink: 0; user-select: none; font-size: 20px; font-weight: 433.3;">&#xE001;</span>
            <span class="min-w-0 flex-1 truncate">Account</span>
          </button>
        </li>
        <li data-testid="usage-settings"><button type="button" class="flex h-control w-full items-center gap-sm rounded px-sm text-left text-body transition-colors cursor-pointer text-secondary hover:bg-fill-ghost-hover hover:text-primary"><span data-cds="Icon" class="shrink-0 text-secondary" aria-hidden="true" style="font-family: var(--font-anthropicons, Anthropicons-Variable); font-size: 20px;">&#xE002;</span><span class="min-w-0 flex-1 truncate">Usage</span></button></li>
        <li><button type="button" class="flex h-control w-full items-center gap-sm rounded px-sm text-left text-body transition-colors cursor-pointer text-secondary hover:bg-fill-ghost-hover hover:text-primary"><span data-cds="Icon" class="shrink-0 text-secondary" aria-hidden="true" style="font-family: var(--font-anthropicons, Anthropicons-Variable); font-size: 20px;">&#xE003;</span><span class="min-w-0 flex-1 truncate">Capabilities</span></button></li>
        <li data-testid="claude-code-settings"><button type="button" class="flex h-control w-full items-center gap-sm rounded px-sm text-left text-body transition-colors cursor-pointer text-secondary hover:bg-fill-ghost-hover hover:text-primary"><span data-cds="Icon" class="shrink-0 text-secondary" aria-hidden="true" style="font-family: var(--font-anthropicons, Anthropicons-Variable); font-size: 20px;">&#xE004;</span><span class="min-w-0 flex-1 truncate">Claude Code</span></button></li>
        <li><button type="button" class="flex h-control w-full items-center gap-sm rounded px-sm text-left text-body transition-colors cursor-pointer text-secondary hover:bg-fill-ghost-hover hover:text-primary"><span data-cds="Icon" class="shrink-0 text-secondary" aria-hidden="true" style="font-family: var(--font-anthropicons, Anthropicons-Variable); font-size: 20px;">&#xE005;</span><span class="min-w-0 flex-1 truncate">Cowork</span></button></li>
      </ul>

      <!-- next group: header div then ul, again plain siblings -->
      <div class="px-sm pt-md text-caption text-muted">Desktop app</div>
      <ul class="flex flex-col gap-px">
        <li><button type="button" class="flex h-control w-full items-center gap-sm rounded px-sm text-left text-body transition-colors cursor-pointer text-secondary hover:bg-fill-ghost-hover hover:text-primary"><span data-cds="Icon" class="shrink-0 text-secondary" aria-hidden="true" style="font-family: var(--font-anthropicons, Anthropicons-Variable); font-size: 20px;">&#xE006;</span><span class="min-w-0 flex-1 truncate">General</span></button></li>
        <li><button type="button" class="flex h-control w-full items-center gap-sm rounded px-sm text-left text-body transition-colors cursor-pointer text-secondary hover:bg-fill-ghost-hover hover:text-primary"><span data-cds="Icon" class="shrink-0 text-secondary" aria-hidden="true" style="font-family: var(--font-anthropicons, Anthropicons-Variable); font-size: 20px;">&#xE007;</span><span class="min-w-0 flex-1 truncate">Extensions</span></button></li>
        <li><button type="button" class="flex h-control w-full items-center gap-sm rounded px-sm text-left text-body transition-colors cursor-pointer text-secondary hover:bg-fill-ghost-hover hover:text-primary"><span data-cds="Icon" class="shrink-0 text-secondary" aria-hidden="true" style="font-family: var(--font-anthropicons, Anthropicons-Variable); font-size: 20px;">&#xE008;</span><span class="min-w-0 flex-1 truncate">Developer</span></button></li>
      </ul>

      <div class="px-sm pt-md text-caption text-muted">Customize</div>
      <ul class="flex flex-col gap-px">
        <li data-testid="customize-skills-settings"><button type="button" class="flex h-control w-full items-center gap-sm rounded px-sm text-left text-body transition-colors cursor-pointer text-secondary hover:bg-fill-ghost-hover hover:text-primary"><span data-cds="Icon" class="shrink-0 text-secondary" aria-hidden="true" style="font-family: var(--font-anthropicons, Anthropicons-Variable); font-size: 20px;">&#xE009;</span><span class="min-w-0 flex-1 truncate">Skills</span></button></li>
      </ul>

      <!-- org section: header div then a bare <a> (no ul) - tolerate this shape -->
      <div class="px-sm pt-md text-caption text-muted">Example Org</div>
      <a href="/admin-settings/organization" class="flex h-control !cursor-pointer items-center gap-sm rounded px-sm text-body text-secondary hover:bg-fill-ghost-hover hover:text-primary"><span data-cds="Icon" class="shrink-0 text-secondary" aria-hidden="true" style="font-family: var(--font-anthropicons, Anthropicons-Variable); font-size: 20px;">&#xE00A;</span><span class="min-w-0 flex-1 truncate">Organization</span><span data-cds="Icon" class="text-muted" aria-hidden="true" style="font-family: var(--font-anthropicons, Anthropicons-Variable); font-size: 20px;">&#xE00B;</span></a>
    </div>
  </nav>

  <!-- content pane -->
  <div class="flex min-h-0 min-w-0 flex-1 flex-col bg-surface-2">
    <div class="flex shrink-0 items-center justify-between pl-xl pr-md pt-md pb-sm"><!-- close button row --></div>
    <div class="shrink-0 px-xl"></div>
    <div class="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-xl pb-lg pt-2 ..."><!-- sections -->
    </div>
  </div>
</div>
```
