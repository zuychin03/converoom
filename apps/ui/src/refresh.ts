// One load at a time; requests made while a load runs are served by exactly one trailing load.
export function coalesce(load: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | undefined, again = false;
  return () => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await load();
        } while (again);
      } finally {
        running = undefined;
      }
    })();
    return running;
  };
}
