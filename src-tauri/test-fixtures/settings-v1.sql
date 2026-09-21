CREATE TABLE workspaces (
    id INTEGER PRIMARY KEY CHECK(id BETWEEN 1 AND 9007199254740991),
    path TEXT NOT NULL UNIQUE CHECK(length(path) > 0)
) STRICT;

CREATE TABLE app_settings (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    open_tab_limit INTEGER NOT NULL DEFAULT 8 CHECK(open_tab_limit BETWEEN 1 AND 9007199254740991),
    auto_save INTEGER NOT NULL DEFAULT 1 CHECK(auto_save IN (0, 1)),
    theme_color TEXT NOT NULL DEFAULT 'sky' CHECK(theme_color IN ('yellow', 'sky', 'mint', 'coral', 'lavender')),
    content_width TEXT NOT NULL DEFAULT 'default' CHECK(content_width IN ('default', 'full')),
    theme_color_redesign_v1 INTEGER NOT NULL DEFAULT 1 CHECK(theme_color_redesign_v1 IN (0, 1)),
    last_workspace_id INTEGER REFERENCES workspaces(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE shortcut_overrides (
    action_id TEXT PRIMARY KEY NOT NULL CHECK(action_id IN (
        'bold', 'italic', 'inlineCode', 'codeBlock', 'link', 'image',
        'save', 'favorite', 'toggleSidebar', 'toggleOutline', 'toggleView', 'toggleFullscreen'
    )),
    chord TEXT NOT NULL CHECK(length(chord) > 0)
) STRICT;

CREATE TABLE oss_sync (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
    region TEXT NOT NULL CHECK(length(trim(region)) > 0),
    endpoint TEXT NOT NULL CHECK(length(trim(endpoint)) > 0),
    bucket TEXT NOT NULL CHECK(length(trim(bucket)) > 0),
    prefix TEXT NOT NULL,
    access_key_id TEXT NOT NULL CHECK(length(trim(access_key_id)) > 0),
    access_key_secret TEXT NOT NULL CHECK(length(trim(access_key_secret)) > 0)
) STRICT;

CREATE TABLE favorite_documents (
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
    document_path TEXT NOT NULL CHECK(length(document_path) > 0),
    favorited_at INTEGER NOT NULL CHECK(favorited_at BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY(workspace_id, document_path)
) STRICT;

CREATE TABLE recent_documents (
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
    document_path TEXT NOT NULL CHECK(length(document_path) > 0),
    edited_at INTEGER NOT NULL CHECK(edited_at BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY(workspace_id, document_path)
) STRICT;

CREATE INDEX favorite_documents_order ON favorite_documents(workspace_id, favorited_at DESC, document_path ASC);
CREATE INDEX recent_documents_order ON recent_documents(workspace_id, edited_at DESC, document_path ASC);

CREATE TRIGGER workspaces_no_delete
BEFORE DELETE ON workspaces
BEGIN
    SELECT RAISE(ABORT, 'workspace records cannot be deleted');
END;
