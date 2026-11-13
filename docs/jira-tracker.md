# Jira issue tracker

Opt-in Community feature: Settings -> Extra -> Community Features -> Code -> **Jira issue tracker** (off by default, applies live). A **Jira** row in the main window's sidebar, or <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>J</kbd>, opens a page over the content area with your Jira Cloud tickets, the ticket detail, status changes and **Send to agent**. Jira Cloud only (`*.atlassian.net`); Jira Server and Data Center are not supported.

Patch: [`add_feature_jira_tracker.nim`](../patches/community/add_feature_jira_tracker.nim). Anchors: [baseline/JIRA_TRACKER_ANCHORS.md](../baseline/JIRA_TRACKER_ANCHORS.md).

## Setup

1. Create an API token at https://id.atlassian.com/manage-profile/security/api-tokens. A classic token can do what your Jira account can do. A scoped token with `read:jira-work`, `read:jira-user` and `write:jira-work` works (tested 2026-11-12); this set is sufficient, not proven minimal. The Board/Backlog sections, the board columns and the moves use Jira Software's Agile API; it has no classic scopes, so a scoped token needs the granular ones in the table below. Without them Jira answers 401 "Unauthorized; scope does not match", the list groups by status with a one-time notice, and the board shows the project's workflow statuses as columns (read with `read:jira-work`). A classic token is not affected. The diag line `[cdb-jira] groups: agile unavailable` or `board: configuration unavailable` carries Jira's reason. See Atlassian's scope list: https://developer.atlassian.com/cloud/jira/platform/scopes-for-oauth-2-3LO-and-forge-apps/.
   | Feature | Endpoint | Scopes (granular) |
   |---|---|---|
   | Board lookup | `GET /rest/agile/1.0/board?projectKeyOrId=` | `read:board-scope:jira-software`, `read:project:jira` (inferred from tokens with and without it, 2026-11-12) |
   | Board / Backlog sections | `GET /rest/agile/1.0/board/{id}/backlog` | `read:board-scope:jira-software`, `read:issue-details:jira` |
   | Board view columns | `GET /rest/agile/1.0/board/{id}/configuration` | `read:board-scope.admin:jira-software` |
   | Active sprint (Scrum) | `GET /rest/agile/1.0/board/{id}/sprint` | `read:sprint:jira-software` (not checked) |
   | Move to backlog | `POST /rest/agile/1.0/backlog/{boardId}/issue` | `write:board-scope:jira-software` |
   | Move to board (team-managed, Kanban) | `POST /rest/agile/1.0/board/{id}/issue` | `write:board-scope:jira-software` |
   | Move to board (Scrum) | `POST /rest/agile/1.0/sprint/{id}/issue` | `write:sprint:jira-software` (not checked) |

   Source: https://developer.atlassian.com/cloud/jira/software/rest/api-group-board/ and the scope list below. Seen 2026-11-12: a token without `read:issue-details:jira` and `read:board-scope.admin:jira-software` got 401 on the backlog and the configuration while the board lookup worked.
2. Switch **Jira issue tracker** on. Enter your site (a pasted board or ticket link is reduced to `https://<name>.atlassian.net`), your Atlassian email and the token, then **Save site, email and token** and **Test connection**.
3. The token is stored encrypted with the system keyring for this profile. Without GNOME Keyring or KWallet the row says so and refuses to store it.

## How requests reach Jira

- Basic auth (email + token), first to your site. When the site answers 401 (a scoped token), the app reads the site's cloud ID from `<site>/_edge/tenant_info` without a credential and uses `https://api.atlassian.com/ex/jira/<cloudId>`. The route that worked is remembered and detected again once after a later 401. A new site, email or token forgets it.
- Only your site and `api.atlassian.com` are contacted. Redirects are refused; attachments are read with `?redirect=false`, and one that still redirects shows as a chip. At most four requests run at a time, each with a 15 s timeout. A 429 waits for `Retry-After` (at most 30 s) and retries once.

## The page

- **Tickets:** "Assigned to me, not done" (default), "Reported by me, not done", a project filter, free JQL (up to 2,000 characters) and named saved queries (stored on this computer). **Sort** orders by Updated (default), Priority, Created or Key, remembered for the profile. 50 per page, **Load more**, **Refresh**; data older than 60 s refreshes when the page gets focus. A new search replaces one that is still loading, and a late answer to the old one is dropped, so a tab clicked during loading never shows the previous tab's rows.
- **Rows:** line 2 shows the key, the type, a coloured priority icon and the assignee (not under **Assigned to me**). Status labels in the list, the subtask rows, the cards and the detail are coloured by Jira's status category, with a dot before the name: hollow for To Do, filled for In Progress and Done. Dates in the list and the detail are relative for the last 7 days ("3h ago"), then "Oct 13" (with the year when it is not this year); hover for the full date and time.
- **Subtasks:** a ticket with subtasks has a chevron and an "N subtasks · M done" chip. Done subtasks (Jira's Done status category) are listed last and dimmed, under the row and in the detail. The chevron (or the right / left arrow key on the row) shows its subtasks as compact rows under it; their assignee, priority and date are read once per search. A subtask whose parent is on the page appears only under the parent; section counts, the Board count and the **Backlog N** link count top-level rows. While more pages can load, a count covers only the loaded rows and shows a "+" (for example "23+"). The detail lists the subtasks after the description.
- **Detail:** click a ticket for its description, attachments and last five comments, **Open in Jira**, the status menu and **Send to agent**. Links open in your browser (https and mailto only). The Details card hides empty fields; **Parent** opens the parent ticket. In a narrow panel the title comes first, then the actions and a collapsed **Details** card, then the description. Opening Details there lasts for the session and does not change the choice saved for the wide layout.
- **Attachments:** the main process downloads a file only when it belongs to the ticket that is open, with your credential (the token never reaches the page), and hands the page the bytes. PNG, JPEG, GIF and WebP up to 10 MB show inline; MP4 and WebM up to 50 MB play inline; anything else (SVG included) is a chip with **Save to Downloads** (a safe, unique file name in your Downloads folder) and **Open in Jira**. Images in the description are matched to attachments as Jira renders them. A click (or Enter) on an image, a video or an image chip opens a viewer over the page: zoom with the wheel, + / - / 0 (Ctrl+= and Ctrl+- zoom the image there, not the app), drag to pan, double-click for fit or 100 % (the bar shows the zoom percentage), the large arrows at the sides or the arrow keys for the other images of the same description or comment, **Download**, **Open in Jira**, Escape to close. Up to 50 MB of files are kept in memory. Downloads are limited to 200 MB.
- **Board / Backlog / Done:** for each project on the page the app asks Jira for the project's board (the first one; **Filter** lets you pick another, remembered per project) and that board's backlog. Rows in the backlog go under **Backlog**, the other open rows under **Board**, done rows under **Done**. When the Agile API refuses (for example a scoped token without the Jira Software scopes) or the project has no board, open-sprint and in-progress rows go under **Board** and the rest under **Backlog**, with a one-time notice.
- **Move to board / Move to backlog:** in a row's **...** menu and the ticket sidebar. On a team-managed or Kanban board the ticket is added to the board; on a Scrum board to the active sprint ("No active sprint" disables it). The row shows "pending..." until Jira's backlog shows the ticket in its new place. Jira can report that place a little late, so the tracker reads the backlog up to five times over about 6 seconds before it shows "Jira accepted the move but the ticket did not move."
- **Status:** the menu lists Jira's transitions; one that needs more fields is disabled with "Needs fields - open in Jira". The row shows "pending..." until Jira answers.
- **Open:** the Jira row in the sidebar or Ctrl+Shift+J.
- **Close:** another sidebar row, a navigation in claude.ai, the Jira row or the shortcut again.

## Board

**Board** next to **List** shows the Board rows (not the Backlog) as cards in the columns of the project's Jira board, read from the board configuration; each column holds one or more statuses, in the board's order. Without the Agile configuration the columns are the project's workflow statuses for the issue types on screen, so every status is a drop target. With tickets from several projects there is one column per status on screen. Columns that do not come from a board configuration are ordered To Do, In Progress, Done, then by name. Columns are 260 px wide; a board wider than the page scrolls sideways.

- **Drag rules:** drag a card to another column, or use **...** -> **Move to column**. One fitting transition runs at once. Several open a menu at the drop point that asks which. A column that has no transition, or only transitions that need fields, sends the card back with the reason. Escape cancels a drag.
- **Order:** cards keep their order within a column (no ranking). In a column that holds several statuses, each card shows its status.
- **Backlog N** above the board returns to the list.

## Theme

The page uses claude.ai's colours, including a custom theme from Settings -> Extra -> Themes. The app reads them when the page opens, when it gets focus, when the system theme changes, and every second while it is open: a custom theme and claude.ai's own appearance switch change the page's CSS without an event the app can listen to.

In a light theme, secondary and faint text is clamped in oklch to at most 0.5 and 0.48 lightness and at least 0.66 and 0.62 opacity, and the To Do status, menus, the selected tab and hovered rows use the body text clamped to 0.45 lightness. Some light themes (Solarized, claude.ai's default with its translucent black) have secondary text too light to read on the page; a theme whose text is dark enough keeps its own colour. Dark themes keep their colours unchanged.

## Send to agent

Start it from the sparkle button on each list row, from a row's **...** menu, or from **Send to agent**, the main button in the ticket detail.

1. The app reads the ticket again from Jira.
2. A folder picker opens at the last folder used for that Jira project. Cancel stops.
3. A folder the app does not trust yet asks first (**Trust and start** / **Cancel**); trust is saved only after Trust and start.
4. A new Code session starts in that folder as a normal user-started session, with your default permission mode, in its own worktree when the folder is a git repository with at least one commit.
5. The Jira page closes and the app opens the new session (or shows "Started <KEY> in <folder>").

The first message comes from the prompt template in the settings row. Placeholders: `{{key}}`, `{{summary}}`, `{{url}}`, `{{type}}`, `{{priority}}`, `{{description}}` (the description as Markdown, at most 20,000 characters). Ticket text is framed as data inside `<ticket>...</ticket>`; a `</ticket>` inside the ticket becomes `</ticket_>`. **Reset template** restores the default.

## Limits

- A claude.ai menu, dialog or command palette that opens over the content area is hidden behind the page; a sidebar menu that extends past the sidebar edge is clipped. Close the page to reach them.
- Find-in-page and Cowork artifact views can appear above the page; when an artifact view opens in the same window, the page closes.
- On claude.ai the sidebar row is found by its English label ("Scheduled", else "Artifacts"). With the claude.ai interface in another language no Jira row appears; the shortcut still opens the page.
- While the page is open it covers part of the sidebar's resize handle. Close the page to resize the sidebar.
- The upstream row that was active before (for example Scheduled) keeps its highlight while the Jira page is open.
- The board's columns have a fixed width (260 px). A better width for wide windows is still open.
- In a light theme, the state and note lines and the buttons of the Jira row in Settings -> Extra -> Community can fall below the AA contrast ratio. They use the shared Extra settings styles, which a separate change will fix.
- The folder picker and the trust dialog of **Send to agent** are native GTK dialogs and follow the system theme, not the claude.ai theme.
- Not covered: editing fields, writing comments, uploading attachments, avatars (initials only), Jira saved filters, creating or ranking sprints, ranking cards within a column, sending to an open session.

## Privacy and files

- `cdb-jira-credentials.json` (site, email, detected route and cloud ID, the token as keyring ciphertext) and `cdb-jira-state.json` (saved queries, last preset and project, last folder per project, prompt template), both mode 0600 in the profile directory; the page files in `cdb-jira-tracker/`.
- `[cdb-jira]` lines in `claude-patches.log` carry the request method, path (ticket keys replaced by `<key>`) and status, and fixed event names - never ticket text, JQL, the token or a URL query.

## Troubleshooting

| Log line | Meaning |
|---|---|
| `[cdb-jira] anchor:sidebar` | The sidebar row anchor was not found; the shortcut still opens the page. |
| `[cdb-jira] anchor:row-text` | The sidebar has rows, but none is labelled "Scheduled" or "Artifacts" (another language, or a renamed row); the shortcut still opens the page. |
| `[cdb-jira] anchor:content` | The sidebar edge was not found; the page covers the whole view and shows a close button; Ctrl+Shift+J also closes it. |
| `[cdb-jira] hook:native-view missing` / `hook:session-manager missing` | An upstream anchor moved; Send to agent or the artifact close rule is unavailable until the patch is refit. |
| `[cdb-jira] navigate: no dispatcher` | The app could not open the new session; the notice names it instead. |
