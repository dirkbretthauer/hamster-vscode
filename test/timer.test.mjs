/**
 * `java.util.Timer`/`TimerTask` and `Calendar`/`Date` on the simulation clock
 * (issue #65). Every run injects `now`, so wall-clock time never leaks into
 * the assertions: the clock is `now()` at start plus 100 ms per scheduler step.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runSimulation, terrainFile } from '../scripts/test-helpers/simulationHarness.mjs';

const START = new Date(2026, 9, 30, 11, 59, 0).getTime();
const now = () => START;
const terrain = terrainFile(['>    ', '     '], [0], 0);

function run(program, options = {}) {
    return runSimulation({ terrain, program: '/*object-oriented program*/\n' + program, now, ...options });
}

test('a delayed task runs once at its scheduled time and then the program ends', async () => {
    const result = await run(`
        import java.util.Timer;
        import java.util.TimerTask;
        class Hello extends TimerTask {
            long origin = System.currentTimeMillis();
            public void run() {
                schreib("ran after " + (this.scheduledExecutionTime() - this.origin));
                schreib("on time " + (System.currentTimeMillis() >= this.scheduledExecutionTime()));
            }
        }
        void main() {
            new Timer().schedule(new Hello(), 500);
            schreib("scheduled");
        }`);
    assert.equal(result.status, 'finished');
    assert.deepEqual(result.output, ['scheduled', 'ran after 500', 'on time true']);
    assert.ok(result.scheduler.currentTimeMillis() >= START + 500);
});

test('an immediate task runs without delay', async () => {
    const result = await run(`
        import java.util.*;
        class Now extends TimerTask {
            long origin = System.currentTimeMillis();
            public void run() { schreib("at " + (this.scheduledExecutionTime() - this.origin)); }
        }
        void main() { new Timer().schedule(new Now(), 0); }`);
    assert.equal(result.status, 'finished');
    assert.deepEqual(result.output, ['at 0']);
});

test('a fixed-rate task repeats on its period until it cancels itself', async () => {
    const result = await run(`
        import java.util.*;
        class Tick extends TimerTask {
            int count = 0;
            long origin = System.currentTimeMillis();
            public void run() {
                this.count = this.count + 1;
                schreib("tick " + this.count + " @" + (this.scheduledExecutionTime() - this.origin));
                if (this.count == 3) { this.cancel(); }
            }
        }
        void main() { new Timer().scheduleAtFixedRate(new Tick(), 200, 300); }`);
    assert.equal(result.status, 'finished');
    assert.deepEqual(result.output, ['tick 1 @200', 'tick 2 @500', 'tick 3 @800']);
});

test('a task given a Date as first execution fires at that instant, skipping idle time', async () => {
    const result = await run(`
        import java.util.*;
        class Lunch extends TimerTask {
            public void run() {
                Calendar now = Calendar.getInstance();
                schreib("lunch at " + now.get(Calendar.HOUR_OF_DAY) + ":" + now.get(Calendar.MINUTE));
            }
        }
        void main() {
            Calendar noon = Calendar.getInstance();
            noon.set(Calendar.HOUR_OF_DAY, 12);
            noon.set(Calendar.MINUTE, 0);
            noon.set(Calendar.SECOND, 0);
            noon.add(Calendar.DAY_OF_MONTH, 1);
            new Timer().schedule(new Lunch(), noon.getTime());
        }`);
    // Finishing at all proves the jump: a day is 864000 steps, far beyond maxSteps.
    assert.equal(result.status, 'finished');
    assert.deepEqual(result.output, ['lunch at 12:0']);
});

test('Timer.cancel stops a repeating task and lets the program end', async () => {
    const result = await run(`
        import java.util.*;
        class Counter extends TimerTask {
            public void run() { schreib("run"); }
        }
        void main() {
            Timer timer = new Timer();
            timer.schedule(new Counter(), 0, 100);
            vor(); vor(); vor();
            timer.cancel();
            schreib("cancelled");
        }`);
    // Finishing at all proves the repeat stopped; a run claimed before cancel() may still complete.
    assert.equal(result.status, 'finished');
    const afterCancel = result.output.slice(result.output.indexOf('cancelled') + 1);
    assert.ok(afterCancel.length <= 1, JSON.stringify(result.output));
    assert.ok(result.output.filter((line) => line === 'run').length >= 1);
});

test('cancelling a task before it runs prevents it; purge removes it from the queue', async () => {
    const result = await run(`
        import java.util.*;
        class Never extends TimerTask {
            public void run() { schreib("should not run"); }
        }
        void main() {
            Timer timer = new Timer();
            Never task = new Never();
            timer.schedule(task, 1000);
            schreib("first cancel " + task.cancel());
            schreib("second cancel " + task.cancel());
            schreib("purged " + timer.purge());
        }`);
    assert.equal(result.status, 'finished');
    assert.deepEqual(result.output, ['first cancel true', 'second cancel false', 'purged 1']);
});

test('illegal schedule calls throw catchable Java exceptions', async () => {
    const result = await run(`
        import java.util.*;
        class Noop extends TimerTask { public void run() { } }
        void main() {
            Timer timer = new Timer();
            try { timer.schedule(new Noop(), -1); } catch (IllegalArgumentException e) { schreib("negative delay"); }
            try { timer.schedule(new Noop(), 0, 0); } catch (IllegalArgumentException e) { schreib("bad period"); }
            Noop task = new Noop();
            timer.schedule(task, 10);
            try { timer.schedule(task, 10); } catch (IllegalStateException e) { schreib("already scheduled"); }
            timer.cancel();
            try { timer.schedule(new Noop(), 10); } catch (IllegalStateException e) { schreib("timer cancelled"); }
        }`);
    assert.equal(result.status, 'finished');
    assert.deepEqual(result.output, ['negative delay', 'bad period', 'already scheduled', 'timer cancelled']);
});

test('an exception in a task cancels its timer without killing the program', async () => {
    const result = await run(`
        import java.util.*;
        class Boom extends TimerTask {
            public void run() { schreib("boom"); throw new IllegalStateException("boom"); }
        }
        void main() {
            Timer timer = new Timer();
            timer.schedule(new Boom(), 0, 100);
            vor(); vor(); vor(); vor();
            schreib("main done");
        }`);
    assert.deepEqual(result.output.filter((line) => line === 'boom'), ['boom'], 'the repeat never runs again');
    assert.ok(result.output.includes('main done'));
});

test('the clock is frozen while paused, so repeats neither pile up nor catch up', async () => {
    const program = `
        import java.util.*;
        class Forever extends TimerTask { public void run() { schreib("t"); } }
        void main() { new Timer().scheduleAtFixedRate(new Forever(), 0, 1000); }`;
    const paused = await run(program, { stopAfterSteps: 50 });
    assert.equal(paused.status, 'stopped');
    const clockAtPause = paused.scheduler.currentTimeMillis();
    const runsAtPause = paused.output.length;
    // Pausing is simply not calling step(): no time passes and no task runs.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(paused.scheduler.currentTimeMillis(), clockAtPause);
    assert.equal(paused.output.length, runsAtPause);
    // One step after resuming continues from the frozen time.
    paused.scheduler.step();
    assert.ok(paused.scheduler.currentTimeMillis() - clockAtPause <= 1000 * 2);

    // Stop discards the scheduler; a fresh run starts the clock (and the timers) over.
    const restarted = await run(program, { stopAfterSteps: 1 });
    assert.ok(restarted.scheduler.currentTimeMillis() <= START + 100);
});

test('a daemon timer does not keep the program alive', async () => {
    const result = await run(`
        import java.util.*;
        class Forever extends TimerTask { public void run() { schreib("t"); } }
        void main() {
            new Timer(true).scheduleAtFixedRate(new Forever(), 0, 100);
            vor(); vor();
        }`);
    assert.equal(result.status, 'finished');
});

test('a timer task can command hamsters, like the course samples', async () => {
    const result = await run(`
        import java.util.*;
        class Mover extends TimerTask {
            Hamster hamster;
            Mover(Hamster hamster) { this.hamster = hamster; }
            public void run() {
                this.hamster.vor();
                if (this.hamster.getSpalte() == 3) { this.cancel(); }
            }
        }
        void main() {
            new Timer().scheduleAtFixedRate(new Mover(Hamster.getStandardHamster()), 1000, 3000);
        }`);
    assert.equal(result.status, 'finished', JSON.stringify(result.errors));
    assert.equal(result.hamster().x, 3);
});

test('Calendar and Date expose fields, arithmetic and conversion on the simulation clock', async () => {
    const result = await run(`
        import java.util.*;
        void main() {
            Calendar c = Calendar.getInstance();
            schreib(c.get(Calendar.YEAR) + "-" + c.get(Calendar.MONTH) + "-" + c.get(Calendar.DAY_OF_MONTH)
                + " " + c.get(Calendar.HOUR_OF_DAY) + ":" + c.get(Calendar.MINUTE));
            c.set(2024, Calendar.JANUARY, 31);
            c.add(Calendar.MONTH, 1);
            schreib("clamped " + c.get(Calendar.MONTH) + "/" + c.get(Calendar.DAY_OF_MONTH));
            Date d = c.getTime();
            schreib("millis match " + (d.getTime() == c.getTimeInMillis()));
            java.util.Calendar q = java.util.Calendar.getInstance();
            q.setTime(new java.util.Date());
            schreib("qualified " + q.get(java.util.Calendar.HOUR_OF_DAY));
            schreib("before " + d.before(new Date()));
        }`);
    assert.equal(result.status, 'finished', JSON.stringify(result.errors));
    assert.deepEqual(result.output, [
        '2026-9-30 11:59', 'clamped 1/29', 'millis match true', 'qualified 11', 'before true',
    ]);
});
