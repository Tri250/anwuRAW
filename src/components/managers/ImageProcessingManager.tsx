import { useImageProcessing } from '../../hooks/useImageProcessing';

interface Props {
  transformWrapperRef: React.RefObject<any>;
}

export default function ImageProcessingManager(props: Props) {
  useImageProcessing(props.transformWrapperRef);

  return null;
}
