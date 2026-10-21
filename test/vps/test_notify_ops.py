"""Exercise the root operator's fixed patch and rollback boundary without a VPS."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('notify_ops', Path(__file__).parents[2] / 'scripts/vps/notify_ops.py')
ops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ops)

ORIGINAL = '''other.example.com {
    respond "other"
}
notify.trigenys.com {
    @send {
        method POST
        path /api/sendText
    }
    handle @send {
        reverse_proxy 127.0.0.1:3000
    }
    handle {
        respond 404
    }
}
'''


class NotifyOpsTests(unittest.TestCase):
    def test_adds_only_fixed_read_routes_and_preserves_original(self):
        result = ops.patch_config(ORIGINAL)
        self.assertEqual(result.replace(ops.ROUTE, '', 1), ORIGINAL)
        self.assertIn('method GET', ops.ROUTE)
        self.assertIn('path /api/trigenys-test/groups /api/trigenys-test/groups/count', ops.ROUTE)

    def test_repeat_is_idempotent(self):
        updated = ops.patch_config(ORIGINAL)
        self.assertEqual(ops.patch_config(updated), updated)

    def test_unknown_layout_and_duplicate_sites_are_rejected(self):
        for original in [ORIGINAL.replace('notify.trigenys.com {', 'notify.trigenys.com, other.test {'),
                         ORIGINAL + '\nnotify.trigenys.com {\n}\n']:
            with self.subTest(original=original), self.assertRaises(ops.OpsError):
                ops.patch_config(original)

    def test_modified_managed_route_is_rejected(self):
        updated = ops.patch_config(ORIGINAL).replace('method GET', 'method POST')
        with self.assertRaises(ops.OpsError):
            ops.patch_config(updated)

    def test_route_in_another_site_is_rejected(self):
        updated = ORIGINAL.replace('other.example.com {\n', 'other.example.com {\n' + ops.ROUTE)
        with self.assertRaises(ops.OpsError):
            ops.patch_config(updated)

    def test_arbitrary_operation_is_rejected(self):
        with self.assertRaisesRegex(ops.OpsError, 'OPERATION_NOT_ALLOWED'):
            ops.operate('bash')

    def test_failed_validation_preserves_original(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'Caddyfile'
            config.write_text(ORIGINAL)
            with patch.object(ops, 'validate', side_effect=ops.OpsError('INVALID')):
                with self.assertRaises(ops.OpsError):
                    ops.replace_config(config, ops.patch_config(ORIGINAL), config.stat())
            self.assertEqual(config.read_text(), ORIGINAL)
            self.assertEqual(list(Path(directory).iterdir()), [config])

    def test_reload_failure_restores_original_and_keeps_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'Caddyfile'
            config.write_text(ORIGINAL)
            reloads = []

            def run(args, code):
                if 'reload' in args:
                    reloads.append(args)
                    if len(reloads) == 1:
                        raise ops.OpsError(code)
                return ''

            with patch.object(ops, 'BACKUPS', Path(directory) / 'backups'), patch.object(ops, 'command', side_effect=run):
                with self.assertRaisesRegex(ops.OpsError, 'CADDY_RELOAD_FAILED_CONFIG_RESTORED'):
                    ops.operate('enable-discovery', config)
            self.assertEqual(config.read_text(), ORIGINAL)
            self.assertEqual(len(reloads), 2)
            self.assertEqual(next((Path(directory) / 'backups').iterdir()).read_text(), ORIGINAL)

    def test_success_then_repeated_apply_does_not_reload_again(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'Caddyfile'
            config.write_text(ORIGINAL)
            with patch.object(ops, 'BACKUPS', Path(directory) / 'backups'), patch.object(ops, 'command', return_value='') as run:
                self.assertTrue(ops.operate('enable-discovery', config)['changed'])
                before = len([call for call in run.call_args_list if 'reload' in call.args[0]])
                self.assertTrue(ops.operate('enable-discovery', config)['discovery_enabled'])
                after = len([call for call in run.call_args_list if 'reload' in call.args[0]])
            self.assertEqual(before, 1)
            self.assertEqual(after, 1)


if __name__ == '__main__':
    unittest.main()
