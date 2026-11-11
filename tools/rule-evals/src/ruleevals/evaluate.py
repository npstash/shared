"""Run the scenarios and write the records."""
import queue
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

from ruleevals.checks import RunContext, build_check
from ruleevals.fixture import FixtureMaker
from ruleevals.report import RunRecord
from ruleevals.runner import AgentRunner, Judge
from ruleevals.scenario import RuleEvals, Scenario
from ruleevals.transcript import Transcript, parse_transcript
from ruleevals.trigger import loaded_at_launch, trigger_result

SETUP_TIMEOUT_S: int = 120


@dataclass(frozen=True)
class Job:
    """One run of one scenario on one model."""

    rule: RuleEvals
    scenario: Scenario
    model: str
    run: int

    def name(self) -> str:
        return f"{self.rule.rule_id.replace('/', '_')}.{self.scenario.name}.{self.model}.{self.run}"


class Evaluator:
    """Runs jobs in parallel. Each worker thread uses one fixture slot."""

    def __init__(self, maker: FixtureMaker, runner: AgentRunner, judge: Judge, out_dir: Path, parallel: int) -> None:
        self._maker: FixtureMaker = maker
        self._runner: AgentRunner = runner
        self._judge: Judge = judge
        self._out_dir: Path = out_dir
        self._parallel: int = parallel
        self._slots: queue.Queue[int] = queue.Queue()
        self._lock: threading.Lock = threading.Lock()

    def run(self, jobs: list[Job]) -> list[RunRecord]:
        (self._out_dir / "transcripts").mkdir(parents=True, exist_ok=True)
        for slot in range(self._parallel):
            self._slots.put(slot)
        with ThreadPoolExecutor(max_workers=self._parallel) as pool:
            return list(pool.map(self._run_job, jobs))

    def _run_job(self, job: Job) -> RunRecord:
        slot: int = self._slots.get()
        try:
            record: RunRecord = self._evaluate(job, slot)
        except (OSError, RuntimeError, subprocess.SubprocessError) as error:
            record = self._record(job, "", False, (), None, f"{type(error).__name__}: {error}")
        finally:
            self._slots.put(slot)
        with self._lock:
            with (self._out_dir / "results.jsonl").open("a", encoding="utf-8") as file:
                file.write(record.to_json() + "\n")
            print(f"{job.name()}: trigger={record.trigger} passed={record.passed} {record.error}", flush=True)
        return record

    def _evaluate(self, job: Job, slot: int) -> RunRecord:
        fixture: Path = self._maker.reset(slot)
        for command in job.scenario.setup:
            subprocess.run(command, shell=True, cwd=fixture, check=True, capture_output=True, timeout=SETUP_TIMEOUT_S)
        loaded: bool = loaded_at_launch(fixture, job.rule)
        lines: list[str] = self._runner.run(job.scenario.prompt, job.model, fixture, dict(job.scenario.env))
        (self._out_dir / "transcripts" / f"{job.name()}.jsonl").write_text("\n".join(lines), encoding="utf-8")
        transcript: Transcript = parse_transcript(lines)
        if transcript.is_error:
            return self._record(job, "", False, (), transcript, "the run did not finish")
        context: RunContext = RunContext(job.scenario.prompt, transcript, fixture)
        failed: tuple[str, ...] = tuple(
            spec.label() for spec in job.scenario.checks if not build_check(spec, self._judge).passed(context)
        )
        trigger: str = trigger_result(transcript, job.rule, job.scenario, loaded)
        return self._record(job, trigger, not failed, failed, transcript, "")

    @staticmethod
    def _record(
        job: Job, trigger: str, passed: bool, failed: tuple[str, ...], transcript: Transcript | None, error: str
    ) -> RunRecord:
        return RunRecord(
            rule=job.rule.rule_id,
            scenario=job.scenario.name,
            kind=job.scenario.kind,
            model=job.model,
            run=job.run,
            trigger=trigger,
            passed=passed,
            failed_checks=failed,
            launch_tokens=transcript.launch_tokens if transcript else 0,
            cost_usd=transcript.cost_usd if transcript else 0.0,
            error=error,
        )


def make_jobs(rules: list[RuleEvals], models: list[str], runs: int) -> list[Job]:
    return [
        Job(rule, scenario, model, run)
        for rule in rules
        for scenario in rule.scenarios
        for model in models
        for run in range(1, runs + 1)
    ]
