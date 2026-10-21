import { NewSessionForm } from "../components/NewSessionForm";
import { useOpenSessionFromModal } from "../lib/layout";

export default function NewSessionScreen() {
  return <NewSessionForm onStarted={useOpenSessionFromModal()} />;
}
