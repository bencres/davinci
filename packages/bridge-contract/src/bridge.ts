import type {
  AppUpdateState,
  AssetMeta,
  CliInstallStatus,
  DeletedAsset,
  ExternalFileContent,
  FolderEntry,
  ImportedAsset,
  LocalVaultEntry,
  MoveExternalFileResult,
  ListNotesPageRequest,
  ListNotesPageResponse,
  NoteComment,
  NoteCommentInput,
  NoteContent,
  NoteFolder,
  NoteMeta,
  PastedImageInput,
  RaycastExtensionStatus,
  DirectoryBrowseResult,
  RemoteWorkspaceInfo,
  RemoteWorkspaceProfile,
  RemoteWorkspaceProfileInput,
  ServerCapabilities,
  ServerSessionStatus,
  VaultSettings,
  FlashcardDensity,
  TikzRenderResponse,
  VaultChangeEvent,
  VaultDemoTourResult,
  VaultInfo,
  VaultTextSearchBackendPreference,
  VaultTextSearchCapabilities,
  VaultTextSearchMatch,
  VaultTextSearchToolPaths
} from './ipc'
import type { CustomTemplateFile, WriteTemplateInput } from './templates'
import type { VaultTask } from '@zennotes/shared-domain/tasks'
import type {
  DatabaseDoc,
  DatabaseSidecar,
  DatabaseSummary,
  DbRow
} from '@zennotes/shared-domain/databases'
import type {
  FlashcardDeck,
  FlashcardDeckSummary,
  FlashcardDraft,
  ReviewGrade,
  ReviewLogFile
} from '@zennotes/shared-domain/flashcards'
import type { StudyGamification } from '@zennotes/shared-domain/study-stats'
import type {
  McpClientId,
  McpClientStatus,
  McpInstructionsPayload,
  McpServerRuntime
} from '@zennotes/shared-domain/mcp-clients'

export interface ZenCapabilities {
  supportsUpdater: boolean
  supportsNativeMenus: boolean
  supportsFloatingWindows: boolean
  supportsLocalFilesystemPickers: boolean
  supportsRemoteWorkspace: boolean
  supportsCliInstall: boolean
  /** Custom templates require local-filesystem CRUD; false on web/remote. */
  supportsCustomTemplates: boolean
}

/** Bias the recall/synthesis split of a generation run. */
export type FlashcardCardMix = 'balanced' | 'recall' | 'synthesis'

/** Options for a flashcard-generation request. */
export interface GenerateOptions {
  /** Model id; defaults to the vault's configured model (`claude-sonnet-4-6`). */
  model?: string
  /** Card-density preference; defaults to the vault's configured density. */
  density?: FlashcardDensity
  /**
   * Cards already created for this note (fronts + focus concepts). The model is
   * told to produce different, complementary cards — used by "Generate more" and
   * to avoid re-creating already-saved cards.
   */
  existing?: string[]
  /** Free-text steering appended to the prompt (custom generation). */
  instructions?: string
  /**
   * Persistent generation guidance from vault settings (`flashcardGuidance`).
   * Applied to every run, separate from the one-off `instructions`.
   */
  guidance?: string
  /** Bias toward recall or synthesis cards; defaults to balanced. */
  cardMix?: FlashcardCardMix
  /** Soft target for the number of cards (still clamped to the hard per-run cap). */
  maxCards?: number
}

/** Result of a flashcard-generation request: validated drafts + drop count. */
export interface GenerateResult {
  drafts: FlashcardDraft[]
  /** How many cards Claude returned that failed `normalizeDraft` and were dropped. */
  dropped: number
}

export interface ZenAppInfo {
  name: string
  productName: string
  version: string
  description: string
  homepage?: string
  runtime: 'desktop' | 'web'
}

export interface ZenBridge {
  getCapabilities(): ZenCapabilities
  getAppInfo(): ZenAppInfo

  platform(): Promise<NodeJS.Platform>
  platformSync(): NodeJS.Platform
  listSystemFonts(): Promise<string[]>
  getAppIconDataUrl(): Promise<string | null>
  zoomInApp(): Promise<number>
  zoomOutApp(): Promise<number>
  resetAppZoom(): Promise<number>
  getAppUpdateState(): Promise<AppUpdateState>
  checkForAppUpdates(): Promise<AppUpdateState>
  checkForAppUpdatesWithUi(): Promise<void>
  downloadAppUpdate(): Promise<AppUpdateState>
  installAppUpdate(): Promise<void>
  getServerCapabilities(): Promise<ServerCapabilities | null>
  getServerSession(): Promise<ServerSessionStatus>
  loginServerSession(token: string): Promise<ServerSessionStatus>
  logoutServerSession(): Promise<ServerSessionStatus>
  getRemoteWorkspaceInfo(): Promise<RemoteWorkspaceInfo | null>
  connectRemoteWorkspace(
    baseUrl: string,
    authToken?: string | null
  ): Promise<{ vault: VaultInfo | null; capabilities: ServerCapabilities }>
  disconnectRemoteWorkspace(): Promise<VaultInfo | null>
  listRemoteWorkspaceProfiles(): Promise<RemoteWorkspaceProfile[]>
  saveRemoteWorkspaceProfile(input: RemoteWorkspaceProfileInput): Promise<RemoteWorkspaceProfile>
  deleteRemoteWorkspaceProfile(id: string): Promise<void>
  connectRemoteWorkspaceProfile(
    id: string
  ): Promise<{ vault: VaultInfo | null; capabilities: ServerCapabilities }>

  getCurrentVault(): Promise<VaultInfo | null>
  listLocalVaults(): Promise<LocalVaultEntry[]>
  openLocalVault(root: string): Promise<VaultInfo | null>
  closeVault(): Promise<VaultInfo | null>
  pickVault(): Promise<VaultInfo | null>
  selectVaultPath(path: string): Promise<VaultInfo>
  browseServerDirectories(path?: string): Promise<DirectoryBrowseResult>
  getVaultSettings(): Promise<VaultSettings>
  setVaultSettings(next: VaultSettings): Promise<VaultSettings>
  /** True when the vault is in `inbox` mode but its root holds notes that only
   *  `root` mode would surface (drives the "Switch to Vault root" banner). */
  rootContentHiddenByInboxMode(): Promise<boolean>

  listNotes(): Promise<NoteMeta[]>
  listNotesPage?(request: ListNotesPageRequest): Promise<ListNotesPageResponse>
  listFolders(): Promise<FolderEntry[]>
  listAssets(): Promise<AssetMeta[]>
  hasAssetsDir(): Promise<boolean>
  generateDemoTour(): Promise<VaultDemoTourResult>
  removeDemoTour(): Promise<VaultDemoTourResult>
  listTemplates(): Promise<CustomTemplateFile[]>
  readTemplate(sourcePath: string): Promise<string>
  writeTemplate(input: WriteTemplateInput): Promise<CustomTemplateFile>
  deleteTemplate(sourcePath: string): Promise<void>
  getVaultTextSearchCapabilities(
    paths?: VaultTextSearchToolPaths
  ): Promise<VaultTextSearchCapabilities>
  searchVaultText(
    query: string,
    backend?: VaultTextSearchBackendPreference,
    paths?: VaultTextSearchToolPaths
  ): Promise<VaultTextSearchMatch[]>
  readNote(relPath: string): Promise<NoteContent>
  readNoteComments(relPath: string): Promise<NoteComment[]>
  writeNoteComments(relPath: string, comments: NoteCommentInput[]): Promise<NoteComment[]>
  scanTasks(): Promise<VaultTask[]>
  scanTasksForPath(relPath: string): Promise<VaultTask[]>
  /** Resolves to null when the `.csv` no longer exists (e.g. a stale tab). */
  openDatabase(relPath: string): Promise<DatabaseDoc | null>
  writeDatabaseRows(relPath: string, rows: DbRow[]): Promise<DatabaseDoc>
  writeDatabaseSchema(relPath: string, sidecar: DatabaseSidecar, rows: DbRow[]): Promise<DatabaseDoc>
  createDatabase(folder: NoteFolder, subpath: string, title?: string): Promise<DatabaseDoc>
  /** Rename a database's `.base` folder; resolves to the new `data.csv` path. */
  renameDatabase(csvPath: string, newTitle: string): Promise<string>
  /** Create a record's "page" note (returns its vault-relative path). */
  createRecordPage(csvPath: string, title: string, body: string): Promise<string>
  listDatabases(): Promise<DatabaseSummary[]>

  // --- Flashcards (Phase 1) ---
  /** The saved deck for a note, or null when none exists yet. */
  readFlashcards(notePath: string): Promise<FlashcardDeck | null>
  /** Persist a deck for a note (creating `.zennotes/flashcards/…` as needed). */
  writeFlashcards(notePath: string, deck: FlashcardDeck): Promise<FlashcardDeck>
  /** Enumerate all decks (path + card count) for the cross-deck index. */
  listFlashcardDecks(): Promise<FlashcardDeckSummary[]>
  /** The append-only review-grade log for a note, or null when none exists. */
  readReviewLog(notePath: string): Promise<ReviewLogFile | null>
  /** Append one review grade to a note's log (creating it as needed). */
  appendReviewGrade(notePath: string, grade: ReviewGrade): Promise<ReviewLogFile>
  /** Read the vault-wide study gamification config (defaults when absent). */
  readStudyGamification(): Promise<StudyGamification>
  /** Persist the vault-wide study gamification config, returning the stored value. */
  writeStudyGamification(gamification: StudyGamification): Promise<StudyGamification>
  /** Generate draft cards from a note via Claude. Desktop-only in Phase 1. */
  generateFlashcards(notePath: string, opts: GenerateOptions): Promise<GenerateResult>
  /** Whether an Anthropic API key is stored (never returns the key itself). */
  getAnthropicKeyPresent(): Promise<boolean>
  /** Store (or clear, when empty) the Anthropic API key in the OS secret store. */
  setAnthropicKey(key: string): Promise<void>

  writeNote(relPath: string, body: string): Promise<NoteMeta>
  appendToNote(relPath: string, body: string, position: 'start' | 'end'): Promise<NoteMeta>
  createNote(folder: NoteFolder, title?: string, subpath?: string): Promise<NoteMeta>
  /** Create a new `.excalidraw` drawing seeded with an empty scene. */
  createExcalidraw(folder: NoteFolder, subpath?: string, title?: string): Promise<NoteMeta>
  renameNote(relPath: string, nextTitle: string): Promise<NoteMeta>
  deleteNote(relPath: string): Promise<void>
  moveToTrash(relPath: string): Promise<NoteMeta>
  restoreFromTrash(relPath: string): Promise<NoteMeta>
  emptyTrash(): Promise<void>
  archiveNote(relPath: string): Promise<NoteMeta>
  unarchiveNote(relPath: string): Promise<NoteMeta>
  duplicateNote(relPath: string): Promise<NoteMeta>
  exportNotePdf(relPath: string): Promise<string | null>
  revealNote(relPath: string): Promise<void>
  /** Reveal the original target of a symlinked note in the OS file manager. */
  revealNoteTarget(relPath: string): Promise<void>
  moveNote(relPath: string, targetFolder: NoteFolder, targetSubpath: string): Promise<NoteMeta>
  importFilesToNote(notePath: string, sourcePaths: string[]): Promise<ImportedAsset[]>
  importPastedImage(input: PastedImageInput): Promise<ImportedAsset>
  renameAsset(relPath: string, nextName: string): Promise<AssetMeta>
  moveAsset(relPath: string, targetDir: string): Promise<AssetMeta>
  duplicateAsset(relPath: string): Promise<AssetMeta>
  deleteAsset(relPath: string): Promise<DeletedAsset>
  restoreDeletedAsset(asset: DeletedAsset): Promise<AssetMeta>
  createFolder(folder: NoteFolder, subpath: string): Promise<void>
  renameFolder(folder: NoteFolder, oldSubpath: string, newSubpath: string): Promise<string>
  deleteFolder(folder: NoteFolder, subpath: string): Promise<void>
  duplicateFolder(folder: NoteFolder, subpath: string): Promise<string>
  revealFolder(folder: NoteFolder, subpath: string): Promise<void>
  /** Open the original target directory of a symlinked folder in the OS file manager. */
  revealFolderTarget(folder: NoteFolder, subpath: string): Promise<void>
  revealAssetsDir(): Promise<void>
  getPathForFile(file: File): string | null
  resolveLocalAssetUrl(vaultRoot: string, notePath: string, href: string): string | null
  resolveVaultAssetUrl(vaultRoot: string, assetPath: string): string | null

  onVaultChange(cb: (ev: VaultChangeEvent) => void): () => void
  onOpenSettings(cb: () => void): () => void
  onOpenNoteRequested(cb: (relPath: string) => void): () => void
  notifyRendererReady(): void
  onAppUpdateState(cb: (state: AppUpdateState) => void): () => void

  windowMinimize(): void
  windowToggleMaximize(): void
  windowClose(): void
  openNoteWindow(relPath: string): Promise<void>
  openVaultWindow(): Promise<VaultInfo | null>

  /** Read the markdown file bound to the current standalone editor window. */
  readExternalFile(): Promise<ExternalFileContent>
  /** Save the current standalone editor window's file back to disk. */
  writeExternalFile(body: string): Promise<void>
  /** Move the current standalone editor window's file into the active vault. */
  moveExternalFileToVault(): Promise<MoveExternalFileResult>
  /**
   * Open a markdown file from an absolute OS path — as a note when it lives
   * inside a known vault, otherwise a standalone external-file window. The
   * drag-and-drop counterpart of the Finder "Open in ZenNotes" entry.
   * Resolves to true when a window was opened or focused. Desktop only; the
   * web bridge is a no-op that resolves to false.
   */
  openMarkdownFile(absPath: string): Promise<boolean>
  toggleQuickCapture(): Promise<void>
  getQuickCaptureHotkey(): Promise<string>
  setQuickCaptureHotkey(hotkey: string): Promise<{ ok: boolean; hotkey: string; error?: string }>
  /** Whether the quick-capture window stays pinned on top (won't hide on blur). */
  getQuickCapturePinned(): Promise<boolean>
  setQuickCapturePinned(pinned: boolean): Promise<boolean>
  renderTikz(source: string): Promise<TikzRenderResponse>

  mcpGetRuntime(): Promise<McpServerRuntime>
  mcpGetStatuses(): Promise<McpClientStatus[]>
  mcpInstall(id: McpClientId): Promise<McpClientStatus>
  mcpUninstall(id: McpClientId): Promise<McpClientStatus>
  mcpGetInstructions(): Promise<McpInstructionsPayload>
  mcpSetInstructions(next: string | null): Promise<McpInstructionsPayload>
  cliGetStatus(): Promise<CliInstallStatus>
  cliInstall(): Promise<CliInstallStatus>
  cliUninstall(): Promise<CliInstallStatus>
  raycastGetStatus(): Promise<RaycastExtensionStatus>
  raycastInstall(): Promise<RaycastExtensionStatus>
  clipboardWriteText(text: string): void
  clipboardReadText(): string
}

let installedBridge: ZenBridge | null = null

function getWindowHost(): { zen: ZenBridge } | undefined {
  const host = globalThis as typeof globalThis & { window?: { zen: ZenBridge } }
  return typeof host.window === 'object' ? host.window : undefined
}

export function installZenBridge(bridge: ZenBridge): ZenBridge {
  installedBridge = bridge
  const windowHost = getWindowHost()
  if (windowHost && !windowHost.zen) {
    windowHost.zen = bridge
  }
  return bridge
}

export function getZenBridge(): ZenBridge {
  if (installedBridge) return installedBridge
  const windowHost = getWindowHost()
  if (windowHost?.zen) return windowHost.zen
  throw new Error('Zen bridge has not been installed')
}

declare global {
  interface Window {
    zen: ZenBridge
  }
}

export {}
