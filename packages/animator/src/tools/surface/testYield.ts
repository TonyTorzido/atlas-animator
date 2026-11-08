/*
 * Atlas Animator: original implementation.
 *
 * Setup file of the "surface" vitest project. Surface tests block the worker for up to ~40 s each
 * (rig builds, gate sweeps), and vitest's runner moves from test to test without yielding to the
 * event loop, so a task-update RPC sent at one test boundary can stay unanswered across several
 * blocking tests until its fixed 60 s timeout fires ("Timeout calling onTaskUpdate"). Yielding a
 * macrotask before each test lets the pending reply arrive, so no call waits longer than one test.
 */
import { beforeEach } from "vitest";

beforeEach(() => new Promise<void>((resolve) => setTimeout(resolve, 25)));
