export type UpdateDocument = { root: string; path: string; content: string };
type DocumentFile = { root: string; path: string; kind: string };

export function collectUpdateDocuments(tabs: DocumentFile[], drafts: Record<string, string>, active: DocumentFile | null, latest: string): UpdateDocument[] {
  const key = (file: DocumentFile) => `${file.root}:${file.path}`;
  const documents: UpdateDocument[] = [];
  for (const [draftKey, content] of Object.entries(drafts)) {
    const tab = tabs.find((file) => key(file) === draftKey);
    if (!tab || tab.kind !== "markdown") throw new Error("存在无法定位的未保存文档，请先保存文档后重试。");
    if (active && key(active) === draftKey) continue;
    documents.push({ root: tab.root, path: tab.path, content });
  }
  if (active?.kind === "markdown") documents.push({ root: active.root, path: active.path, content: latest });
  return documents;
}

// Serialize writes so an older autosave can never overwrite the installation snapshot.
export function createSaveQueue(write: (document: UpdateDocument) => Promise<void>) {
  let pending = Promise.resolve();
  return {
    write(document: UpdateDocument) {
      const result = pending.then(() => write(document));
      pending = result.catch(() => {});
      return result;
    },
    async saveBeforeUpdate(documents: UpdateDocument[]) {
      await pending;
      for (const document of documents) await this.write(document);
    },
  };
}
