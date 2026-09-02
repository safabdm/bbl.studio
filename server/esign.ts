export type ESignEnvelope = {
  agreementVersionId: string;
  signerName: string;
  signerEmail: string;
  company: string;
};

export interface ESignAdapter {
  name: string;
  createEnvelope(input: ESignEnvelope): Promise<{ provider: string; envelopeId: string; status: string }>;
}

export const localTypedSignatureAdapter: ESignAdapter = {
  name: 'local-typed-signature',
  async createEnvelope(input) {
    return {
      provider: 'local-typed-signature',
      envelopeId: `local_${input.agreementVersionId}`,
      status: 'captured_in_bbls_audit_log',
    };
  },
};

export const docusignAdapter: ESignAdapter = {
  name: 'docusign',
  async createEnvelope() {
    throw new Error('DocuSign is not configured. This adapter is integration-ready for later production use.');
  },
};

export const dropboxSignAdapter: ESignAdapter = {
  name: 'dropbox_sign',
  async createEnvelope() {
    throw new Error('Dropbox Sign is not configured. This adapter is integration-ready for later production use.');
  },
};

export const pandaDocAdapter: ESignAdapter = {
  name: 'pandadoc',
  async createEnvelope() {
    throw new Error('PandaDoc is not configured. This adapter is integration-ready for later production use.');
  },
};

export const esign = localTypedSignatureAdapter;
