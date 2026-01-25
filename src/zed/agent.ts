import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import * as net from "node:net";

class MyAgent {
  private activeSessionId: string | null = null;
  private pendingPrompt: {
    sessionId: string;
    resolve: (response: acp.PromptResponse) => void;
  } | null = null;

  constructor(private connection: acp.AgentSideConnection) {}

  async initialize(
    params: acp.InitializeRequest,
  ): Promise<acp.InitializeResponse> {
    console.error(
      `Client initialized with protocol v${params.protocolVersion}`,
    );
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
      },
    };
  }

  async newSession(
    params: acp.NewSessionRequest,
  ): Promise<acp.NewSessionResponse> {
    const sessionId = crypto.randomUUID();
    this.activeSessionId = sessionId;
    console.error(`New session created: ${sessionId} in ${params.cwd}`);

    return {
      configOptions: [],
      sessionId,
    };
  }

  async authenticate(
    params: acp.AuthenticateRequest,
  ): Promise<acp.AuthenticateResponse> {
    console.error(
      `Authentication request received for method: ${params.methodId}`,
    );
    return {};
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    console.error(
      `Prompt received for session ${params.sessionId}:`,
      params.prompt,
    );
    if (this.pendingPrompt) {
      console.warn(
        `Prompt already pending for ${this.pendingPrompt.sessionId}; ending it.`,
      );
      this.pendingPrompt.resolve({ stopReason: "end_turn" });
    }

    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "please use opencode directly",
        },
      },
    });

    return { stopReason: "end_turn" };
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    console.error(`Cancel requested for session ${params.sessionId}`);
  }

  async setSessionMode(
    params: acp.SetSessionModeRequest,
  ): Promise<acp.SetSessionModeResponse> {
    console.error(
      `Session ${params.sessionId} switched to ${params.modeId} mode`,
    );
    return {};
  }

  async loadSession(
    params: acp.LoadSessionRequest,
  ): Promise<acp.LoadSessionResponse> {
    this.activeSessionId = params.sessionId;
    console.error(`Loaded session ${params.sessionId} from ${params.cwd}`);
    return {
      configOptions: [],
    };
  }

  getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  async publishFileEdited(filePath: string, content: string): Promise<void> {
    const message = JSON.stringify({ filePath, content });
    console.error(`Called Read tool with is following input: ${message}`);
  }
}

interface FileEditedEvent {
  type: "file.edited";
  properties: {
    file: string;
    contentNew: string;
  };
}
let agent: MyAgent | null = null;

const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
const stream = acp.ndJsonStream(input, output);

const connection = new acp.AgentSideConnection((conn) => {
  agent = new MyAgent(conn);
  return agent;
}, stream);

connection.signal.addEventListener("abort", () => {
  console.error("Connection closed");
  process.exit(0);
});

const FILE_EDITED_PORT = Number(process.env.ACP_FILE_EDITED_PORT ?? 41234);

const handleFileEditedEvent = async (event: FileEditedEvent) => {
  if (agent) {
    const sessionId = agent.getActiveSessionId();
    if (!sessionId) {
      console.warn("No active session; skipping writeTextFile.");
      return;
    }
    await connection.writeTextFile({
      sessionId,
      path: event.properties.file,
      content: event.properties.contentNew,
    });
  }
};

const server = net.createServer((socket) => {
  let buffer = "";
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 1000);
  socket.setTimeout(5000);
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const processBuffer = () => {
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          try {
            const event = JSON.parse(line) as FileEditedEvent;
            if (event.type === "file.edited") {
              void handleFileEditedEvent(event);
            }
          } catch (error) {
            console.error("Failed to parse TCP event:", error);
          }
        }
        newlineIndex = buffer.indexOf("\n");
      }
    };
    processBuffer();
  });
  socket.on("end", () => {
    const line = buffer.trim();
    buffer = "";
    if (line.length > 0) {
      try {
        const event = JSON.parse(line) as FileEditedEvent;
        if (event.type === "file.edited") {
          void handleFileEditedEvent(event);
        }
      } catch (error) {
        console.error("Failed to parse TCP event:", error);
      }
    }
  });
  socket.on("timeout", () => {
    socket.destroy();
  });
  socket.on("error", (error) => {
    console.error("TCP socket error:", error);
  });
});

server.on("error", (error) => {
  console.error("TCP server error:", error);
});

server.listen(FILE_EDITED_PORT, "127.0.0.1", () => {
  console.error(`Listening for file.edited on 127.0.0.1:${FILE_EDITED_PORT}`);
});
