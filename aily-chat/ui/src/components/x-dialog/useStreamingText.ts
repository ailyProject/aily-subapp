import { useEffect, useState } from 'react';

export function useStreamingText(content: string, streaming: boolean): string {
  const [visible, setVisible] = useState(content);

  useEffect(() => {
    setVisible(content);
  }, [content, streaming]);

  return visible;
}
