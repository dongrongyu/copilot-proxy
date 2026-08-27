export type SSEDataHandler = (data: string) => void;

class SSEDataObserver {
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private dataLines: string[] = [];

  constructor(private readonly onData: SSEDataHandler) {}

  push(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    this.drainLines(false);
  }

  finish(): void {
    this.buffer += this.decoder.decode();
    this.drainLines(true);
    this.dispatchData();
  }

  private drainLines(final: boolean): void {
    while (this.buffer.length > 0) {
      let lineEnd = -1;
      let terminatorLength = 0;

      for (let index = 0; index < this.buffer.length; index++) {
        const character = this.buffer[index];
        if (character === "\n") {
          lineEnd = index;
          terminatorLength = 1;
          break;
        }
        if (character === "\r") {
          if (index === this.buffer.length - 1 && !final) return;
          lineEnd = index;
          terminatorLength = this.buffer[index + 1] === "\n" ? 2 : 1;
          break;
        }
      }

      if (lineEnd === -1) {
        if (final) {
          const line = this.buffer;
          this.buffer = "";
          this.processLine(line);
        }
        return;
      }

      const line = this.buffer.slice(0, lineEnd);
      this.buffer = this.buffer.slice(lineEnd + terminatorLength);
      this.processLine(line);
    }
  }

  private processLine(line: string): void {
    if (line === "") {
      this.dispatchData();
      return;
    }
    if (line.startsWith(":")) return;

    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    if (field !== "data") return;

    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    this.dataLines.push(value);
  }

  private dispatchData(): void {
    if (this.dataLines.length === 0) return;
    const data = this.dataLines.join("\n");
    this.dataLines = [];
    this.onData(data);
  }
}

/**
 * Forward an SSE byte stream unchanged while observing its decoded data fields.
 * Transport framing stays byte-for-byte identical to the upstream response.
 */
export async function forwardSSEStream(
  source: ReadableStream<Uint8Array>,
  write: (chunk: Uint8Array) => Promise<unknown>,
  onData: SSEDataHandler = () => {},
): Promise<void> {
  const reader = source.getReader();
  const observer = new SSEDataObserver(onData);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      observer.push(value);
      await write(value);
    }
    observer.finish();
  } finally {
    reader.releaseLock();
  }
}
