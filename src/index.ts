import { applyPatch } from "diff";

export type NotificationPluginDeps = {
  project: unknown;
  client: unknown;
  $: unknown;
  directory: unknown;
  worktree: unknown;
};

const FILE_EDITED_PORT = Number(process.env.ACP_FILE_EDITED_PORT ?? 41234);

type MessagePartUpdated = {
  type: "message.part.updated";
  properties: {
    part: {
      id: string;
      type: string;
      tool: string;
      sessionID: string;
      state: {
        status: string;
        input: {
          content: string;
          filePath: string;
          oldString: string;
          newString: string;
        };
        metadata: {
          diff: string;
          filediff: {
            file: string;
            before: string;
            after: string;
            additions: string;
            deletions: string;
          };
        };
      };
    };
  };
};

type PermissionAsked = {
  type: "permission.asked";
  properties: {
    id: string;
    sessionID: string;
    metadata: {
      filepath: string;
      diff: string;
    };
  };
};

type PermissionReplied = {
  type: "permission.replied";
  properties: {
    sessionID: string;
    requestID: string;
    reply: string;
  };
};

type EventPayload = {
  event: MessagePartUpdated | PermissionAsked | PermissionReplied;
};

function normalize(text: string) {
  return text.replace(/\r\n/g, "\n");
}

function normalizeDiff(diff: string) {
  return diff
    .split("\n")
    .filter((l) => {
      const trimmed = l.trimStart();
      return !trimmed.startsWith("Index:") && !trimmed.startsWith("===");
    })
    .join("\n")
    .replace(/^--- .*/m, "--- a/file.ts")
    .replace(/^\+\+\+ .*/m, "+++ b/file.ts");
}

function extractDiffInfo(diff: string) {
  const normalized = normalize(diff);
  const lines = normalized.split("\n");
  const cleanPath = (value?: string) => {
    if (!value) return undefined;
    const cleaned = value.replace(/^([ab]\/)*/, "").trim();
    if (cleaned === "/dev/null" || cleaned === "dev/null") {
      return undefined;
    }
    return cleaned;
  };
  const getPathWithPrefix = (prefix: string) => {
    const line = lines.find((entry) => entry.startsWith(`${prefix} `));
    return line?.slice(prefix.length + 1).trim();
  };
  const plusPath = getPathWithPrefix("+++");
  const minusPath = getPathWithPrefix("---");
  const indexLine = lines.find((entry) => entry.startsWith("Index: "));
  const indexPath = indexLine?.slice("Index: ".length).trim();
  const filepath = cleanPath(plusPath ?? minusPath ?? indexPath);
  return { filepath, diff: normalizeDiff(normalized) };
}

async function editAsk() {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const configPath = path.join(
    os.homedir(),
    ".config",
    "opencode",
    "opencode.json",
  );
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as {
      permission?: {
        edit?: string;
      };
    };
    const editPermission = parsed.permission?.edit;
    if (!editPermission) return false;
    if (editPermission === "ask") return true;
    return false;
  } catch {
    return false;
  }
}

const isEditAsk = await editAsk();

export const NotificationPlugin = async ({
  project: _project,
  client: _client,
  $: _$,
  directory: _directory,
  worktree: _worktree,
}: NotificationPluginDeps) => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const appDataDir =
    process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  const logDir = path.join(appDataDir, "opencode", "bridge-logs");
  const logPath = path.join(logDir, "plugin.log");
  const appendLog = async (payload: unknown) => {
    await fs.mkdir(logDir, { recursive: true });
    const line = `${new Date().toISOString()} ${JSON.stringify(payload)}\n`;
    await fs.appendFile(logPath, line, "utf8");
  };
  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  const sendFileEdited = async (
    net: typeof import("node:net"),
    file: string,
    contentNew: string,
  ) => {
    const payload = JSON.stringify({
      type: "file.edited",
      properties: { file, contentNew },
    });
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const ok = await new Promise<boolean>((resolve) => {
        const socket = net.createConnection(
          { host: "127.0.0.1", port: FILE_EDITED_PORT },
          () => {
            socket.setNoDelay(true);
            socket.setKeepAlive(true, 1000);
            socket.setTimeout(3000);
            socket.write(`${payload}\n`, (writeError) => {
              if (writeError) {
                resolve(false);
              } else {
                resolve(true);
              }
              socket.end();
            });
          },
        );
        socket.on("timeout", () => {
          socket.destroy();
          resolve(false);
        });
        socket.on("error", (error) => {
          console.error("NotificationPlugin TCP error:", error);
          resolve(false);
        });
      });
      if (ok) {
        return;
      }
      await sleep(200 * attempt);
    }
    await appendLog({ tcpSendFailed: { file } });
  };
  const pendingEdits = new Map<string, { file: string; contentNew: string }>();

  return {
    event: async ({ event }: EventPayload) => {
      if (event.type === "message.part.updated" && !isEditAsk) {
        const net = await import("node:net");
        const properties = event.properties;
        const part = properties.part;
        if (part.type === "tool") {
          if (part.tool === "edit") {
            const state = part.state;
            if (state.status === "running") {
              const input = state.input;
              const filePath = input.filePath;
              const contentNew = input.newString;
              await sendFileEdited(net, filePath, contentNew);
            }
          } else if (part.tool === "write") {
            const state = part.state;
            if (state.status === "completed") {
              const input = state.input;
              const filePath = input.filePath;
              const contentNew = input.content;
              await fs.writeFile(filePath, "", "utf8");
              await sendFileEdited(net, filePath, contentNew);
            }
          }
        }
      } else if (event.type === "permission.asked" && isEditAsk) {
        const properties = event.properties;
        const id = properties.id;
        const metadata = properties.metadata;
        const diffRaw = metadata.diff;
        if (diffRaw) {
          const { filepath, diff } = extractDiffInfo(diffRaw);
          if (!filepath) return;
          let contentOld: string = "";
          try {
            await fs.access(filepath);
            contentOld = await fs.readFile(filepath, "utf8");
          } catch {
            await appendLog({ missingFile: filepath });
          }
          const patched = applyPatch(normalize(contentOld), diff);
          if (patched) {
            pendingEdits.set(id, {
              file: filepath,
              contentNew: patched,
            });
          }
        }
      } else if (event.type === "permission.replied" && isEditAsk) {
        const net = await import("node:net");
        const properties = event.properties;
        const id = properties.requestID;
        const reply = properties.reply;
        if (reply == "once") {
          const pending = pendingEdits.get(id);

          if (pending?.file) {
            const filePath = pending.file;
            try {
              await fs.access(filePath);
            } catch {
              await fs.mkdir(path.dirname(filePath), { recursive: true });
              await fs.writeFile(filePath, "", "utf8");
            }
            await appendLog(pending);
            await sendFileEdited(net, pending.file, pending.contentNew);
            pendingEdits.delete(id);
          }
        }
      }
    },
  };
};
