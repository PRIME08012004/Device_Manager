import base64
import json
import os
import tempfile
import unittest
from contextlib import nullcontext
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import app
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa


class LicenseVerificationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.private_key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
        cls.public_key_pem = cls.private_key.public_key().public_bytes(
            serialization.Encoding.PEM,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        ).decode('ascii')

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.license_path = Path(self.temp_dir.name) / 'license.json'
        self.old_public_key = app.PUBLIC_KEY_PEM
        self.old_license_path = app.LICENSE_PATH
        self.old_machine_id = app.machine_id
        self.old_enforcement = app.LICENSE_ENFORCEMENT_ENABLED
        app.PUBLIC_KEY_PEM = self.public_key_pem
        app.LICENSE_PATH = str(self.license_path)
        app.machine_id = lambda: 'controller-test-id'
        app.LICENSE_ENFORCEMENT_ENABLED = False

    def tearDown(self):
        app.PUBLIC_KEY_PEM = self.old_public_key
        app.LICENSE_PATH = self.old_license_path
        app.machine_id = self.old_machine_id
        app.LICENSE_ENFORCEMENT_ENABLED = self.old_enforcement
        self.temp_dir.cleanup()

    def make_document(self, machine='controller-test-id'):
        license_data = {
            'product': 'NEU159',
            'license_id': 'TEST-0001',
            'machine_id': machine,
            'license_type': 'perpetual',
            'issued_at': datetime.now(timezone.utc).isoformat(),
            'expires_at': None,
            'max_devices': 5,
        }
        payload = json.dumps(license_data, sort_keys=True, separators=(',', ':')).encode('utf-8')
        signature = self.private_key.sign(payload, padding.PKCS1v15(), hashes.SHA256())
        return {'license': license_data, 'signature': base64.b64encode(signature).decode('ascii')}

    def test_valid_license_installs_atomically(self):
        document = self.make_document()
        app.install_license(document)

        self.assertTrue(self.license_path.is_file())
        self.assertTrue(app.get_license()['valid'])
        self.assertEqual(json.loads(self.license_path.read_text())['license']['max_devices'], 5)

    def test_dashboard_stays_accessible_without_usb_license(self):
        client = app.app.test_client()

        self.assertEqual(client.get('/').status_code, 200)
        self.assertEqual(client.get('/dashboard').status_code, 200)
        self.assertEqual(client.get('/configuration').status_code, 200)
        self.assertEqual(client.get('/license').status_code, 200)
        self.assertEqual(app.can_add('UnlicensedConfig'), (True, ''))

    def test_private_key_in_signature_is_rejected_without_creating_file(self):
        document = self.make_document()
        document['signature'] = '-----BEGIN PRIVATE KEY-----\nnot-a-signature\n-----END PRIVATE KEY-----'

        with self.assertRaisesRegex(ValueError, 'PEM private key'):
            app.install_license(document)
        self.assertFalse(self.license_path.exists())

    def test_usb_status_surfaces_signature_rejection(self):
        usb_root = Path(self.temp_dir.name) / 'NEU159_USB'
        license_dir = usb_root / 'licenses' / app._license_arch()
        license_dir.mkdir(parents=True)
        document = self.make_document()
        document['signature'] = '-----BEGIN PRIVATE KEY-----\nnot-a-signature\n-----END PRIVATE KEY-----'
        (license_dir / 'license.lic').write_text(json.dumps(document), encoding='utf-8')

        with patch.object(app, 'usb_license_folder', return_value=nullcontext(str(usb_root))):
            response = app.app.test_client().get('/api/usb/status')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()['state'], 'no_license')
        self.assertIn('PEM private key', response.get_json()['message'])

    def test_tampered_license_contents_fail_signature_check(self):
        document = self.make_document()
        document['license']['max_devices'] = 6

        with self.assertRaisesRegex(ValueError, 'does not match the license contents'):
            app.verify_doc(document)

    def test_line_wrapped_and_backslash_continued_signature_parses(self):
        document = self.make_document()
        signature = document['signature']
        wrapped = signature[:80] + '\\\n' + signature[80:160] + '\n' + signature[160:]
        raw = json.dumps({'license': document['license'], 'signature': wrapped})

        parsed = app._parse_license_json(raw)
        self.assertEqual(parsed['signature'], signature)
        app.verify_doc(parsed)

    def test_raw_newline_wrapped_signature_parses(self):
        document = self.make_document()
        signature = document['signature']
        raw = ('{"license":' + json.dumps(document['license']) + ',"signature":"' +
               signature[:80] + '\n' + signature[80:] + '"}')

        parsed = app._parse_license_json(raw)
        self.assertEqual(parsed['signature'], signature)
        app.verify_doc(parsed)

    def test_machine_id_enforcement_is_configurable(self):
        document = self.make_document(machine='another-controller')
        with patch.dict(os.environ, {'NEU_ENFORCE_MACHINE_ID': 'true'}):
            with self.assertRaisesRegex(ValueError, 'different machine'):
                app.verify_doc(document)

        with patch.dict(os.environ):
            os.environ.pop('NEU_ENFORCE_MACHINE_ID', None)
            self.assertEqual(app.verify_doc(document)['machine_id'], 'another-controller')

    def test_invalid_base64_has_specific_error(self):
        document = self.make_document()
        document['signature'] = 'not base64!'

        with self.assertRaisesRegex(ValueError, 'not valid base64'):
            app.verify_doc(document)

    def test_wrong_signature_length_has_specific_error(self):
        document = self.make_document()
        document['signature'] = base64.b64encode(b'short').decode('ascii')

        with self.assertRaisesRegex(ValueError, 'wrong length'):
            app.verify_doc(document)

    def test_missing_and_extra_top_level_keys_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "missing the 'license' key"):
            app.verify_doc({'signature': 'x'})
        with self.assertRaisesRegex(ValueError, "missing the 'signature' key"):
            app.verify_doc({'license': {}})
        with self.assertRaisesRegex(ValueError, 'unexpected top-level'):
            app.verify_doc({**self.make_document(), 'comment': 'unexpected'})


if __name__ == '__main__':
    unittest.main()
