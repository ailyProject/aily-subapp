import { ChatPart } from '../../protocol';
import { FaIcon } from '../shared/Icon';
import './x-aily-error-viewer.css';

export function XAilyErrorViewer({ part }: { part: ChatPart }) {
  return <div className="x-aily-error-viewer"><FaIcon icon="triangle-exclamation" /><span>{part.content || part.detail}</span></div>;
}
