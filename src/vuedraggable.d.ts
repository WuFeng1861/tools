declare module "vuedraggable" {
  import type { DefineComponent } from "vue";
  const draggable: DefineComponent<Record<string, unknown>>;
  export default draggable;
}
