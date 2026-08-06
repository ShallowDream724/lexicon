export type WaitingWorkerDiscovery = "runtime" | "startup";
export type WaitingWorkerAction = "activate" | "ignore" | "prompt";

export function decideWaitingWorkerAction(
  discovery: WaitingWorkerDiscovery,
  hasControllingWorker: boolean,
): WaitingWorkerAction {
  if (!hasControllingWorker) {
    return "ignore";
  }
  return discovery === "startup" ? "activate" : "prompt";
}
