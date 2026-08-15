// Says "optional" in the manifest and then needs it at load time anyway.
import ghost from 'pp-fixture-ghost';

export function summon() {
  return ghost();
}
