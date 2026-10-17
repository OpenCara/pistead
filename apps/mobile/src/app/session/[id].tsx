import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect } from "react";
import { SessionView } from "../../components/SessionView";
import { useWideLayout } from "../../lib/layout";

export default function SessionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const wide = useWideLayout();
  // A window widened while this screen is open (iPad rotation, split screen) shows it beside the list instead.
  useEffect(() => {
    if (wide) router.dismissTo({ pathname: "/", params: { session: id } });
  }, [wide, id, router]);
  if (wide) return null;
  return <SessionView key={id} id={id} embedded={false} />;
}
