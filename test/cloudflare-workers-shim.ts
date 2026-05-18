export class DurableObject<Env = unknown> {
  protected env: Env;

  constructor(_ctx: DurableObjectState, env: Env) {
    this.env = env;
  }
}
