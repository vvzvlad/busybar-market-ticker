import { device } from "@shared/device";
import type { DisplayDrawParams } from "@busy-app/busy-lib";

/** One display element as DisplayDraw takes it. */
export type Element = DisplayDrawParams["elements"][number];

/** Front display of the app. */
export interface Screen {
  /** Draws a whole frame; elements of the previous frame that are not in it are cleared. */
  show(elements: Element[]): void;
  /** Stops drawing: frames asked for after this are dropped. */
  close(): void;
}

/**
 * Keeps at most one display request in flight: a frame asked for while one is on its way waits, and a newer one
 * replaces it.
 */
export function createScreen(app: string, report: (err: unknown) => void): Screen {
  let shown: string[] = [];
  let next: Element[] | null = null;
  let busy = false;
  let closed = false;

  async function flush(): Promise<void> {
    busy = true;
    while (next && !closed) {
      const elements = next;
      next = null;
      const ids = elements.map((e) => e.id);
      const gone = shown.filter((id) => ids.indexOf(id) < 0);
      try {
        if (gone.length > 0) {
          await device.DisplayClear({ application_name: app, element_ids: gone });
          shown = shown.filter((id) => ids.indexOf(id) >= 0);
        }
        await device.DisplayDraw({ application_name: app, priority: 50, elements });
        shown = ids;
      } catch (err) {
        report(err);
      }
    }
    busy = false;
  }

  return {
    show(elements) {
      if (closed) return;
      next = elements;
      if (!busy) void flush();
    },
    close() {
      closed = true;
    },
  };
}
