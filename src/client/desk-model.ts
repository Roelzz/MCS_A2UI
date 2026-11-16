import type { DataModel } from "@a2ui/web_core/v0_9";

export function bindDeskPreview(model: DataModel): () => void {
  const update = (selection: unknown) => {
    const device = Array.isArray(selection) && selection.length === 1 ? selection[0] : undefined;
    if (device !== "laptop" && device !== "monitor" && device !== "headset") {
      return;
    }
    const detail = model.get<unknown>(`/deviceDetails/${device}`);
    if (detail && typeof detail === "object" && !Array.isArray(detail)) {
      model.set("/preview", detail);
    }
  };
  update(model.get<unknown>("/deviceSelection"));
  const subscription = model.subscribe<unknown>("/deviceSelection", update);
  return () => subscription.unsubscribe();
}
