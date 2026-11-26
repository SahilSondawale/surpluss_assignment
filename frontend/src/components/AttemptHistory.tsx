import type { Attempt } from '@/lib/api';
import { formatDuration, formatTime } from './format';

/** Every processing attempt of one event. */
export function AttemptHistory({ attempts }: { attempts: Attempt[] }) {
  if (attempts.length === 0) {
    return <p className="muted">No attempts yet.</p>;
  }

  return (
    <table className="attempts">
      <thead>
        <tr>
          <th>#</th>
          <th>Worker</th>
          <th>Started</th>
          <th>Finished</th>
          <th>Duration</th>
          <th>Result</th>
          <th>Error</th>
        </tr>
      </thead>
      <tbody>
        {attempts.map((attempt) => (
          <tr key={attempt.attemptNumber}>
            <td>{attempt.attemptNumber}</td>
            <td>{attempt.workerId}</td>
            <td>{formatTime(attempt.startedAt)}</td>
            <td>{attempt.finishedAt ? formatTime(attempt.finishedAt) : '-'}</td>
            <td>{formatDuration(attempt.startedAt, attempt.finishedAt)}</td>
            <td>
              <span className={`badge result-${attempt.result ?? 'running'}`}>
                {attempt.result ?? 'running'}
              </span>
            </td>
            <td className="error-text">{attempt.error ?? ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
