import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

const [sidepanelHtml, sidepanelCss, sidepanelSource, appHtml, appCss, appSource, commonSource] = await Promise.all([
  read('extension/sidepanel.html'),
  read('extension/sidepanel.css'),
  read('extension/sidepanel.js'),
  read('extension/app.html'),
  read('extension/app.css'),
  read('extension/app.js'),
  read('extension/lib/common.mjs'),
]);

test('Bot Mode is off by default and has no visible Agent Deck product wording', () => {
  assert.match(commonSource, /botModeEnabled:\s*false/);
  for (const source of [sidepanelHtml, sidepanelSource, appHtml, appSource]) {
    assert.doesNotMatch(source, /Agent Deck/i);
  }
});

test('Profiles always load; cron and PetDex stay Bot-Mode-gated', () => {
  // Profiles are a shared Hermes runtime surface: the Settings Active-profile
  // selector and regular (non-Bot) sessions need the verified roster even
  // with Bot Mode off. Only the Bot Mode deck UI is gated behind the toggle.
  assert.match(sidepanelSource, /async function loadProfiles\(\{ quiet = false \} = \{\}\) \{\s*\/\/ Profiles load regardless of Bot Mode/);
  assert.match(sidepanelSource, /async function loadCronJobs\(\{ quiet = false \} = \{\}\) \{\s*if \(settings\.botModeEnabled !== true\) return/);
  assert.match(sidepanelSource, /async function ensurePetGallery\(\) \{\s*if \(settings\.botModeEnabled !== true\) return/);
});
test('side panel exposes an opt-in Bot Mode settings control and roster overlay', () => {
  for (const id of ['botModeButton', 'botModePanel', 'botModeSearch', 'botModeRoster', 'botModeStatus', 'botModeEnabledInput']) {
    assert.match(sidepanelHtml, new RegExp(`id=["']${id}["']`));
  }
  assert.match(sidepanelCss, /\.bot-mode-panel/);
  assert.match(sidepanelCss, /\.bot-mode-row/);
  assert.match(sidepanelSource, /normalizeBotProfileList/);
  assert.match(sidepanelSource, /WS_METHODS\.profilesList/);
  assert.doesNotMatch(sidepanelSource, /apiFetch\(['"]\/v1\/profiles/);
  assert.doesNotMatch(sidepanelSource, /apiFetch\(['"]\/v1\/profiles\/active/);
});

test('Hermes Web exposes an Agents rail backed by the shared Bot Mode domain', () => {
  for (const id of ['agentsRailButton', 'botModeRail', 'webBotModeSearch', 'webBotModeRoster', 'settingsBotModeEnabled']) {
    assert.match(appHtml, new RegExp(`id=["']${id}["']`));
  }
  assert.match(appCss, /\.bot-mode-rail/);
  // The web rail keeps using the shared Bot Mode domain: rows are split into
  // agent profiles and group chats by splitBotRosterRows.
  assert.match(appSource, /splitBotRosterRows/);
  assert.match(appSource, /WS_METHODS\.profilesList/);
});

test('both Browser surfaces pass explicit profiles on list, history, create, and resume', () => {
  assert.match(sidepanelSource, /WS_METHODS\.sessionList,\s*\{[^}]*profile:/s);
  assert.match(sidepanelSource, /WS_METHODS\.sessionHistory,\s*\{[^}]*profile:/s);
  assert.match(sidepanelSource, /establishGatewaySession\(\{[^}]*profile:/s);
  assert.match(appSource, /WS_METHODS\.sessionList,\s*\{[^}]*profile:/s);
  assert.match(appSource, /WS_METHODS\.sessionHistory,\s*\{[^}]*profile:/s);
  assert.match(appSource, /establishGatewaySession\(\{[^}]*profile:/s);
});

test('Bot Mode deck footer carries Edit Profile and New Agent beside the primary open action', () => {
  assert.match(sidepanelHtml, /id="botModeEditButton"[^>]*data-i18n="bot_mode\.edit_profile"/s);
  assert.match(sidepanelHtml, /id="botModeNewAgentButton"[^>]*data-i18n="bot_mode\.new_agent"/s);
  assert.match(sidepanelHtml, /id="botModeOpenButton"[^>]*class="[^"]*bot-mode-action primary/s);
  assert.match(sidepanelSource, /openBotProfileSheet\(\{ mode: 'edit'/);
  assert.match(sidepanelSource, /openBotProfileSheet\(\{ mode: 'create' \}\)/);
});

test('Bot Mode profile sheet owns the editor surface with avatar/general tabs and save', () => {
  for (const id of [
    'botModeSheet',
    'botModeSheetTitle',
    'botModeSheetMeta',
    'botModeSheetCloseButton',
    'botModeSheetTabs',
    'botModeSheetAvatarPreview',
    'botModeSheetFaceGrid',
    'botModeSheetImageInput',
    'botModeSheetAvatarClear',
    'botModeSheetNameInput',
    'botModeSheetTitleInput',
    'botModeSheetDescriptionInput',
    'botModeSheetWarning',
    'botModeSheetSaveButton',
  ]) {
    assert.match(sidepanelHtml, new RegExp(`id=["']${id}["']`));
  }
  assert.match(sidepanelHtml, /id="botModeSheet"[^>]*role="dialog"/s);
  assert.match(sidepanelCss, /\.bot-mode-sheet/);
  assert.match(sidepanelSource, /hermesBotProfileOverrides/);
  assert.match(sidepanelSource, /ui_meta_expected_revisions/);
  assert.doesNotMatch(sidepanelSource, /\/api\/profiles\/\$\{encodeURIComponent\(profileName\)\}\/ui-meta/);
  assert.doesNotMatch(sidepanelSource, /\/api\/profiles\/\$\{encodeURIComponent\(profileName\)\}\/avatar/);
  assert.match(sidepanelSource, /WS_METHODS\.profilesCreate/);
  assert.match(sidepanelSource, /normalizeAvatarImageFile/);
  assert.match(sidepanelSource, /WS_METHODS\.profilesCreate/);
  assert.match(sidepanelSource, /WS_METHODS\.profilesDescribe/);
  assert.match(sidepanelSource, /WS_METHODS\.profilesConfigure/);
  assert.match(sidepanelSource, /WS_METHODS\.profilesSetAsset/);
  assert.match(sidepanelSource, /disabled_skills/);
  assert.match(sidepanelSource, /enabled_toolsets/);
  assert.match(sidepanelSource, /enabled_mcp_servers/);
  assert.doesNotMatch(sidepanelSource, /const tools = \[/);
  assert.doesNotMatch(sidepanelSource, /const mcps = \[/);
  assert.match(sidepanelSource, /ui_meta_expected_revisions/);
  assert.match(sidepanelSource, /await loadProfiles\(\)/);
  assert.doesNotMatch(sidepanelSource, /Local first — offline-first/);
  assert.doesNotMatch(sidepanelSource, /saved on this device\.`/);
});

test('Bot Mode exposes a session-menu Threads control and clears stale bot session identity before default pinning', () => {
  assert.match(sidepanelHtml, /id="botModeThreadsButton"[^>]*hidden/);
  assert.match(sidepanelHtml, /id="botModeThreadsButton"[^>]*data-i18n="bot_mode\.threads"/);
  assert.match(sidepanelSource, /groupThreadMenuEntries\(activeGroupProjection\)/);
  assert.match(sidepanelSource, /bot_mode\.group_threads/);
  assert.match(sidepanelSource, /data-group-thread-id/);
  assert.match(sidepanelSource, /sessionId:\s*''/);
  assert.match(sidepanelSource, /m\.provider === pinnedModel\.provider/);
  assert.match(sidepanelCss, /\.bot-mode-threads-button/);
});

test('regular profile changes show a context choice and panel boot does not resurrect Bot Chats', () => {
  assert.match(sidepanelHtml, /id="profileSwitchDialog"/);
  assert.match(sidepanelHtml, /id="profileSwitchCarryButton"/);
  assert.match(sidepanelHtml, /id="profileSwitchCleanButton"/);
  assert.match(sidepanelHtml, /id="profileSwitchCancelButton"/);
  assert.match(sidepanelSource, /shouldPromptForProfileSwitch\(/);
  assert.match(sidepanelSource, /buildProfileContextHandoff\(/);
  assert.match(sidepanelSource, /pendingProfileContextHandoff/);
  assert.match(sidepanelSource, /function leaveBotModeForRegularSession\(/);
  assert.match(sidepanelSource, /openGroupThreadMenu\(/);
  assert.match(sidepanelHtml, /id="botModeNewThreadButton"/);
  assert.match(sidepanelHtml, /id="groupSettingsModal"/);
  assert.match(sidepanelHtml, /id="botModeLeaveDialog"/);
  assert.match(sidepanelSource, /if \(!sameProfile && !viaBotMode\)/);
  assert.match(sidepanelSource, /function renderBotChatIntro\(row = null\)/);
  assert.match(sidepanelSource, /const isBotChatSession = document\.body\.classList\.contains\('bot-mode-engaged'\)/);
  assert.match(sidepanelSource, /if \(!activeRow \|\| settings\.botModeEnabled !== true \|\| !isBotChatSession\)/);
  const newSessionHandler = sidepanelSource.slice(
    sidepanelSource.indexOf('els.newSessionButton.addEventListener'),
    sidepanelSource.indexOf('els.createSessionButton.addEventListener'),
  );
  assert.match(newSessionHandler, /beginHermesBrowserDraft\(/);
});

test('named-profile drafts and reopened sessions stay on the profile-aware dashboard transport', () => {
  const draftBody = sidepanelSource.match(/async function beginHermesBrowserDraft\([\s\S]*?(?=\nasync function )/)?.[0] || '';
  const openBody = sidepanelSource.match(/async function openHermesSession\([\s\S]*?(?=\nasync function )/)?.[0] || '';
  assert.match(draftBody, /isNamedHermesProfile\(/);
  assert.match(draftBody, /transport:\s*'dashboard-ws'/);
  assert.match(openBody, /session\.transport/);
  assert.match(openBody, /isNamedHermesProfile\(session\.profile/);
});

test('local dashboard fallback and first-paint loading never depend on a stale API key', () => {
  assert.match(sidepanelSource, /if \(state\.state === 'unconfigured' && !usesDashboardWsChatTransport\(\)\)/);
  assert.match(sidepanelSource, /activateLocalDashboardTransport\(\{ timeoutMs: 5_000 \}\)/);
  assert.match(sidepanelSource, /loadModels\(\{ quiet: true, startup: true \}\)/);
  assert.match(sidepanelSource, /dashboard-roster-timeout/);
  assert.match(sidepanelSource, /ensureProfileWsConnection\(\{ readyTimeoutMs: 5_000 \}\)/);
  assert.match(sidepanelSource, /transportUsesDashboardTicket\(settings\.connectionTransport\)/);
  assert.match(sidepanelSource, /!botModeRoster\.length\) void loadProfiles\(\{ quiet: true \}\)/);
});

test('profile switching and bot opening use cached row metadata before slow model options', () => {
  assert.match(sidepanelSource, /void refreshModelCatalogInBackground\(\)\.then/);
  assert.match(sidepanelSource, /let pinnedModel = row\.model \? \{ model: row\.model/);
  assert.match(sidepanelSource, /timeoutMs: 3_000/);
});

test('Bot Mode preserves the first regular profile and isolates generic session controls', () => {
  const openBotBody = sidepanelSource.match(/async function openBotProfile\([\s\S]*?(?=\nasync function )/)?.[0] || '';
  const menuBody = sidepanelSource.match(/function sessionMenuGroups\([\s\S]*?(?=\nfunction )/)?.[0] || '';
  assert.match(openBotBody, /botModeReturnProfile/);
  assert.match(openBotBody, /settings\.botModeReturnProfile\s*\|\|/);
  assert.match(menuBody, /isBotModeEngaged\(\)/);
  assert.match(sidepanelSource, /if \(isBotModeEngaged\(\)/);
});

test('the petdex picker moved out of Settings into the profile sheet', () => {
  const settingsSection = sidepanelHtml.match(/<section class="settings-section bot-mode-settings"[\s\S]*?<\/section>/)?.[0] || '';
  assert.ok(settingsSection.includes('botModeSettingsTitle'), 'bot mode settings section is present');
  assert.doesNotMatch(settingsSection, /botModePetGrid/);
  assert.doesNotMatch(settingsSection, /botModePetSearch/);
  assert.doesNotMatch(settingsSection, /botModePetApply/);
  const sheetSection = sidepanelHtml.match(/<section id="botModeSheet"[\s\S]*?<\/section>/)?.[0] || '';
  assert.ok(sheetSection.includes('botModeSheetTitle'), 'profile sheet is present');
  for (const id of ['botModePetGrid', 'botModePetSearch', 'botModePetApply', 'botModePetClear', 'botModePetHint']) {
    assert.ok(sheetSection.includes(`id="${id}"`), `${id} lives in the profile sheet`);
  }
  // lib/pet-avatar.mjs stays the backing store for the petdex gallery.
  assert.match(sidepanelSource, /from '\.\/lib\/pet-avatar\.mjs'/);
});

test('active-now chips render above the roster rows', () => {
  assert.match(sidepanelHtml, /id="botModeActiveStrip"/);
  assert.match(sidepanelHtml, /id="botModeActiveStrip"[^>]*hidden/s);
  assert.match(sidepanelSource, /renderBotModeActiveStrip/);
  assert.match(sidepanelSource, /activity\.activeNow/);
  assert.match(sidepanelCss, /\.bot-mode-chip/);
});

test('Bot Mode settings expose an Active Cron Jobs viewer card', () => {
  for (const id of ['botModeCronCard', 'botModeCronList', 'botModeCronStatus', 'botModeCronRefreshButton']) {
    assert.match(sidepanelHtml, new RegExp());
  }
  assert.match(sidepanelHtml, /data-i18n="bot_mode.cron_title"/);
  assert.match(sidepanelCss, /.bot-mode-cron-card/);
  assert.match(sidepanelCss, /.bot-mode-cron-badge/);
  assert.match(sidepanelCss, /.bot-mode-cron-tag/);
  assert.match(sidepanelSource, /async function loadCronJobs/);
  assert.match(sidepanelSource, /function renderCronJobs/);
  assert.match(sidepanelSource, /normalizeCronJobRows/);
  assert.ok(sidepanelSource.includes("'/api/jobs'"), 'cron viewer reads the profile-scoped Jobs API');
  assert.match(sidepanelSource, /botModeCronRefreshButton/);
  assert.match(sidepanelSource, /async function runCronJobNow/);
  assert.match(sidepanelSource, /\/api\/jobs\/\$\{encodeURIComponent\(job\.id\)\}\/run/);
  assert.match(sidepanelSource, /action:\s*'run'/);
  assert.match(sidepanelSource, /bot-mode-cron-run/);
  assert.match(sidepanelCss, /\.bot-mode-cron-run/);
  assert.match(sidepanelCss, /\.bot-mode-cron-refresh[\s\S]*line-height:\s*1/);
  assert.match(sidepanelSource, /Next fire \$\{cronRelativeTime\(job\.nextRunAt, now\)\}/);
});

test('verified agent count belongs to Active profile instead of the cron card', () => {
  const cronCard = sidepanelHtml.match(/<details class="bot-mode-cron-card"[\s\S]*?<\/details>/)?.[0] || '';
  const profileCard = sidepanelHtml.match(/<section class="settings-section agent-profile-card">[\s\S]*?<\/section>/)?.[0] || '';
  assert.doesNotMatch(cronCard, /verified agent/i);
  assert.match(profileCard, /id="profileVerifiedCount"/);
  assert.match(sidepanelSource, /profileVerifiedCount\.textContent/);
});

test('cross-profile messaging drops profile-stale session identity and re-binds immediately', () => {
  // The cached live session id must never outlive its profile.
  assert.match(sidepanelSource, /connection\.profile = desiredProfile/);
  assert.match(sidepanelSource, /connection\.profile = safeActiveProfile\(\)/);
  assert.match(sidepanelSource, /if \(connection\.wsSessionId && connection\.profile !== desiredProfile\)/);
  // Every bot open starts a fresh profile-bound Bot Chat session (desktop
  // parity: the canonical-resume path was removed because a durable id from
  // another profile failed the profile-boundary check and stranded sends).
  assert.match(sidepanelSource, /viaBotMode: true/);
  assert.match(sidepanelSource, /createHermesBrowserSession\(\{ title: BOT_CHAT_TITLE, hidden: true/);
  assert.doesNotMatch(sidepanelSource, /createHermesBrowserSession\(\{ title: `\$\{botProfileDisplayName\(row\)\} · Bot Chat`/);
  // The gateway session handshake always carries the active profile.
  assert.match(sidepanelSource, /establishGatewaySession\(\{[\s\S]*?profile: safeActiveProfile\(\)/);
});

test('canonical Bot and group chats bind history, sends, and model switching to their roster dashboard socket', () => {
  assert.match(sidepanelSource, /let activeConversationTransport = 'rest'/);
  assert.match(sidepanelSource, /let activeDashboardWsConnection = null/);
  assert.match(sidepanelSource, /function usesDashboardWsChatTransport/);
  assert.match(sidepanelSource, /async function ensureActiveDashboardWsConnection/);
  assert.match(sidepanelSource, /shouldUseBotDashboardTransport\(\{/);
  assert.match(sidepanelSource, /transport: 'dashboard-ws'/);
  assert.match(sidepanelSource, /fetchSessionMessagesQuietly\(sessionId,[\s\S]*activeDashboardWsConnection/);
  assert.match(sidepanelSource, /if \(usesDashboardWsChatTransport\(\)\) return streamDashboardWsChat/);
  assert.match(sidepanelSource, /if \(usesDashboardWsChatTransport\(\)\) \{[\s\S]*buildSessionModelSwitchRequest/);
  // The same active dashboard transport must be selected before askHermes
  // performs any session preflight. A local Desktop Bot Chat has no ordinary
  // Browser-session REST route, so the generic preflight would strand sends
  // before prompt.submit is reached.
  const askHermesBody = sidepanelSource.match(/async function askHermes\([\s\S]*?(?=\nasync function )/)?.[0] || '';
  assert.ok(askHermesBody, 'askHermes body is present');
  assert.match(askHermesBody, /const dashboardTransport = usesDashboardWsChatTransport\(\);/);
  assert.match(askHermesBody, /activeRunControl = beginRunControl\(\{ transport: dashboardTransport \? 'dashboard-ws' : 'rest' \}\)/);
  assert.match(askHermesBody, /if \(dashboardTransport\) \{[\s\S]*?const dashboardConnection = await ensureActiveDashboardWsConnection\(\);[\s\S]*?await ensureRemoteWsSession\(dashboardConnection\);[\s\S]*?\} else \{\s*await ensureHermesSession\(\);/);
  assert.match(sidepanelSource, /async function sendSteerText[\s\S]*?if \(usesDashboardWsChatTransport\(\)\) \{/);
  assert.match(sidepanelSource, /async function reconcileActiveRunTerminal[\s\S]*?const dashboardTransport = usesDashboardWsChatTransport\(\)/);
  assert.match(sidepanelSource, /async function stopCurrentTurn[\s\S]*?const dashboardTransport = usesDashboardWsChatTransport\(\)[\s\S]*?if \(dashboardTransport\) \{/);
});

test('the model catalog survives agent switches via the profile-union cache', () => {
  assert.match(sidepanelSource, /async function readCachedModelCatalogUnion/);
  assert.match(sidepanelSource, /unionCachedModelCatalogs/);
  assert.match(sidepanelSource, /globalModelCatalogCacheKey/);
  assert.match(sidepanelSource, /mergeModelsByRawId\(\[registryModels, cachedUnionModels\]\)/);
  assert.match(sidepanelSource, /MODEL_CATALOG_SHARED_CACHE_PROFILE/);
});

test('streaming renders with prefix-stable patches, sticky autoscroll, and agent headers', () => {
  assert.match(sidepanelSource, /function patchRenderedMessageContent/);
  assert.match(sidepanelSource, /patchRenderedMessageContent\(element, renderMarkdownSafe\(content \|\| ''\)\)/);
  assert.match(sidepanelSource, /function isMessageStreamNearBottom/);
  assert.match(sidepanelSource, /function scrollMessageStreamToBottom/);
  assert.match(sidepanelSource, /assistantMessageRoleLabel/);
  // The same bubble renderer and identity header are universal, not gated to Bot Mode.
  assert.match(sidepanelCss, /\.message\.assistant \.message-role/);
  assert.doesNotMatch(sidepanelCss, /\.bot-mode-engaged \.message\.(?:assistant|user)/);
});

test('group chats are separated from agent profiles on both Browser surfaces', () => {
  // Rosters split into agents + group chats; synced launch-room never counts as a profile.
  for (const source of [sidepanelSource, appSource]) {
    assert.match(source, /splitBotRosterRows/);
    assert.match(source, /botModeGroupChats|webBotModeGroupChats/);
    assert.match(source, /CANONICAL_FALLBACK_PROFILES/);
    assert.match(source, /CANONICAL_FALLBACK_GROUP_CHATS/);
  }
  // The synced group list stays separate from the agent roster. The selected
  // room uses the profile-scoped runtime bridge rather than a read-only guard.
  for (const source of [sidepanelSource, appSource]) {
    assert.doesNotMatch(source, /BOT_GROUP_CHATS_STORAGE_KEY/);
    assert.doesNotMatch(source, /createGroupChatDraft/);
    assert.doesNotMatch(source, /sourceId === 'device'/);
    assert.doesNotMatch(source, /persist(?:Web)?GroupChats/);
  }
  for (const id of ['botModeViewAgents', 'botModeViewGroups', 'botModeGroupList']) {
    assert.match(sidepanelHtml, new RegExp(`id=["']${id}["']`));
  }
  assert.match(sidepanelSource, /function setBotModeView/);
  assert.match(sidepanelSource, /function renderBotModeGroupChats/);
  assert.match(sidepanelSource, /activeGroupProjection/);
  assert.match(sidepanelSource, /function sendActiveGroupMessage/);
  assert.match(sidepanelSource, /createBotGroupRuntime/);
  assert.match(sidepanelSource, /persistGroupProjectionAppend/);
  assert.match(sidepanelSource, /Group chat opened/);
  assert.doesNotMatch(sidepanelSource, /Group chat is read only/);
  assert.doesNotMatch(sidepanelSource, /function openBotGroupChat[\s\S]{0,900}openHermesSession/);
  // Web rail parity: toggle + synced group list + the same live runtime bridge.
  for (const id of ['webBotModeViewAgents', 'webBotModeViewGroups', 'webBotModeGroupList']) {
    assert.match(appHtml, new RegExp(`id=["']${id}["']`));
  }
  assert.doesNotMatch(appHtml, /webBotModeNewGroupButton|webBotModeGroupForm/);
  assert.match(appSource, /function setWebBotModeView/);
  assert.match(appSource, /function renderWebBotModeGroupChats/);
  assert.match(appSource, /function sendActiveWebGroupMessage/);
  assert.match(appSource, /createBotGroupRuntime/);
  assert.match(appSource, /persistGroupProjectionAppend/);
  assert.match(appSource, /Group chat opened/);
  assert.doesNotMatch(appSource, /read-only synced projection/);
});

test('Hermes Web profile opening distinguishes successful history hydration from failure', () => {
  assert.match(appSource, /async function openSession\(sessionId, \{ keepLoading = false \} = \{\}/);
  assert.match(appSource, /if \(!keepLoading\) hideRuntimeLoadingState\(\);\s*return true;/);
  assert.match(appSource, /const opened = await openSession\(row\.canonical\.durableId\)/);
  assert.match(appSource, /if \(opened === true\) return opened;/);
  assert.doesNotMatch(appSource, /if \(row\.canonical\.status === 'ready'\) return openSession\(row\.canonical\.durableId\);/);
});

test('Hermes Web uses the shared iMessage bubble contract and projection author labels', () => {
  assert.match(appCss, /\.web-message\.user[\s\S]*?border-radius:\s*18px 18px 4px 18px/);
  assert.match(appCss, /\.web-message\.assistant[\s\S]*?border-radius:\s*18px 18px 18px 4px/);
  assert.match(appCss, /\.web-message\.user[\s\S]*?background:\s*var\(--hermes-blue/);
  assert.match(appCss, /\.web-message\.user \.web-message-role\s*\{\s*display:\s*none/);
  assert.match(appSource, /message\.roleLabel/);
  assert.match(appSource, /message\.roleLabel \|\| 'Hermes'/);
});

test('the shared message renderer is the universal iMessage-style bubble layer', () => {
  // User bubbles: right-aligned accent bubble with tail corner (bottom-right).
  assert.match(sidepanelCss, /\.message\.user \{[^}]*align-self: flex-end/);
  assert.match(sidepanelCss, /\.message\.user \{[^}]*border-radius: 18px 18px 4px 18px/);
  assert.match(sidepanelCss, /\.message\.user \{[^}]*background: var\(--hermes-blue/);
  // Assistant bubbles: left-aligned with tail corner (bottom-left).
  assert.match(sidepanelCss, /\.message\.assistant \{[^}]*align-self: flex-start/);
  assert.match(sidepanelCss, /\.message\.assistant \{[^}]*border-radius: 18px 18px 18px 4px/);
  // User role labels are hidden; assistant headers keep real agent identity.
  assert.match(sidepanelCss, /\.message\.user \.message-role \{ display: none/);
  assert.match(sidepanelCss, /\.message\.assistant \.message-role \{ font: 700 9px\/1 var\(--hermes-font-mono\)/);
  assert.match(sidepanelSource, /function assistantMessageRoleLabel/);
  // Markdown/streaming pipeline stays intact underneath the bubble layer.
  assert.match(sidepanelSource, /patchRenderedMessageContent/);
  assert.match(sidepanelSource, /renderMarkdownSafe/);
});

test('refresh profiles spins its glyph with an honest tooltip and busy state', () => {
  assert.match(sidepanelHtml, /id="refreshProfilesButton"[^>]*data-i18n-title="profile\.refresh_title"/s);
  assert.match(sidepanelHtml, /id="refreshProfilesButton"[\s\S]*?session-refresh-icon/);
  assert.match(sidepanelSource, /refreshProfilesButton[\s\S]*?classList\.add\('is-refreshing'\)/);
  assert.match(sidepanelSource, /refreshProfilesButton[\s\S]*?setAttribute\('aria-busy', 'true'\)/);
  assert.match(sidepanelCss, /#refreshProfilesButton\.is-refreshing \.session-refresh-icon \{ animation: sessionRefreshSpin/);
  assert.match(sidepanelCss, /@media \(prefers-reduced-motion: reduce\) \{[^}]*?#refreshProfilesButton\.is-refreshing \.session-refresh-icon \{ animation: none; \}/);
});

test('Bot Mode falls back to canonical agents when live gateway discovery is empty', () => {
  assert.match(sidepanelSource, /if \(!botModeRoster\.length\) \{/);
  assert.match(sidepanelSource, /splitBotRosterRows\(CANONICAL_FALLBACK_PROFILES/);
  assert.match(sidepanelSource, /Hermes agents connected/);
  assert.match(appSource, /splitBotRosterRows\(CANONICAL_FALLBACK_PROFILES/);
});

test('Bot Mode renders agent welcome intro with Collapse font and avatar', () => {
  assert.match(sidepanelHtml, /id=["']botChatIntro["']/);
  assert.match(sidepanelHtml, /id=["']botChatIntroAvatar["']/);
  assert.match(sidepanelHtml, /id=["']botChatIntroTitle["']/);
  assert.match(sidepanelCss, /\.bot-chat-intro/);
  assert.match(sidepanelCss, /"Collapse"/);
  assert.match(sidepanelSource, /function renderBotChatIntro/);
  assert.match(sidepanelHtml, /id=["']botModeNewGroupButton["']/);
});


