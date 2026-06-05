export function isProcessAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) {
    return false;
  }

  try {
    process.kill(numericPid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") {
      return false;
    }
    return true;
  }
}

export function canSignalProcessGroup() {
  return process.platform !== "win32";
}

export function signalProcessTarget({ pid, pgid }, signal = "SIGTERM") {
  const numericPid = Number(pid);
  const numericGroup = Number(pgid);

  if (canSignalProcessGroup() && Number.isInteger(numericGroup) && numericGroup > 0) {
    try {
      process.kill(-numericGroup, signal);
      return {
        ok: true,
        target: "process_group",
        pid: numericPid,
        pgid: numericGroup,
        signal,
      };
    } catch (error) {
      if (error.code !== "ESRCH") {
        throw error;
      }
    }
  }

  if (Number.isInteger(numericPid) && numericPid > 0) {
    process.kill(numericPid, signal);
    return {
      ok: true,
      target: "process",
      pid: numericPid,
      pgid: Number.isInteger(numericGroup) ? numericGroup : null,
      signal,
    };
  }

  return {
    ok: false,
    target: null,
    pid: numericPid,
    pgid: Number.isInteger(numericGroup) ? numericGroup : null,
    signal,
  };
}
