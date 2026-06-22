import { ChatPart } from '../../protocol';
import { FaIcon } from '../shared/Icon';
import './x-aily-error-viewer.css';

export function XAilyProgressViewer({ part }: { part: ChatPart }) {
  return <div className="x-aily-progress-viewer"><FaIcon icon="spinner-third" spin className="spinner" />{part.content || part.text}</div>;
}
