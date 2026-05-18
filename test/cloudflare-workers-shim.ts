export class DurableObject<CaptunEnv = unknown> {
  protected env: CaptunEnv;

  constructor(_ctx: DurableObjectState, env: CaptunEnv) {
    this.env = env;
  }
}
