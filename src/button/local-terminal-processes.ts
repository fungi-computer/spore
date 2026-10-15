/** Kill only the verified shell session, allowing a bounded race with forks. */
export async function killSessionProcesses(kill: () => Promise<number>) {
  for (let attempt = 0; ; attempt += 1) {
    const code = await kill();
    if (code === 1) return;
    if (code !== 0 || attempt === 7)
      throw new Error("Local terminal process cleanup did not settle");
    await Bun.sleep(10);
  }
}
