import { ChatPart } from '../../protocol';
import { FaIcon } from '../shared/Icon';
import './x-aily-error-viewer.scss';

export function XAilyErrorViewer({ part }: { part: ChatPart }) {
  return (
    <div className="x-aily-error-viewer">
      <FaIcon icon="circle-xmark" />
      <span>{part.content || part.detail}</span>
    </div>
  );
}
