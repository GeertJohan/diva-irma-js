/*!
 * diva-irma-js
 * Copyright(c) 2017 Alliander, Koen van Ingen, Timen Olthof
 * BSD 3-Clause License
 */

// TODO get these from appconfig
const appConfig = {
  baseUrl: 'http://localhost/',
};

const divaConfig = {
  apiKey: 'SECRET',
  cookieSecret: 'StRoNGs3crE7',
  cookieName: 'diva-session',
  cookieSettings: {
    httpOnly: true,
    maxAge: 300000,
    sameSite: true,
    signed: true,
    secure: false, // TODO: NOTE: must be set to true and be used with HTTPS only!
  },
  completeDisclosureSessionEndpoint: '/api/complete-disclosure-session',
  irmaApiServerUrl: 'https://dev-diva-irma-api-server.appx.cloud',
  irmaApiServerPublicKey: `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAql7fb0EMMkqKcXIuvCVb
P+V1qV6AIzhxFlBO8k0GLogMUT6UXJSnXQ3P7iTIfr+/5+yf4dfKNHhalphe+2OB
zspt6zymteKAuQ9/NwUNGTSP4l8mD8wQb5ZyiNMUt6leu42SPe/7uOtcRA6AzN2L
6eKNqUGpNvQZTVwEFNNNiChqrkmQVnoyWVe6fHHooxTCtIyXWJY2WqC8lYStIbZc
NP5xwUdLGOuGo41T7Q+wkR5KqXDif+FKoR7qlG7jEUHcbd1OQe7b6DxzSHCI65Bw
TIZwMj2LtEwB6Op7vemHkeNaPAYK33t5kdyq+P55KMDuJgj+nxpFO00U4msD+CRa
7QIDAQAB
-----END PUBLIC KEY-----`,
};

const verificationEndpoint = '/api/v2/verification';
const jwtIrmaApiServerVerifyOptions = {
  algorithm: 'RS256',
  subject: 'disclosure_result',
};

// TODO fix state in a better way!
const divaState = new Map();

/**
* Module dependencies.
* @private
*/

const BPromise = require('bluebird');
const jwt = require('jsonwebtoken');
const request = require('superagent');

const packageJson = require('./../package.json');

function version() {
  return packageJson.version;
}

// TODO: make this check more sophisticated
function checkAttribute(divaSessionId, attribute) {
  return divaState.get(divaSessionId) !== undefined &&
    divaState.get(divaSessionId).attributes !== undefined &&
  divaState.get(divaSessionId).attributes[attribute] !== undefined;
}

function requireAttribute(attribute) {
  return (req, res, next) => {
    if (checkAttribute(req.divaSessionState.session, attribute)) {
      next();
    } else {
      // TODO: make redirect and label not hard-coded
      const attributesLabel = 'Geslacht';
      res
        .redirect(`/api/start-disclosure-session?attribute=${attribute}&attributesLabel=${attributesLabel}`);
      // res
      //   .status(401)
      //   .send({
      //     success: false,
      //     requiredAttributes: [attribute],
      //     message: `You are missing attribute ${attribute}`,
      //   });
    }
  };
}

function addApiServerUrl(qrContent) {
  return {
    ...qrContent,
    u: `${divaConfig.irmaApiServerUrl}${verificationEndpoint}/${qrContent.u}`,
  };
}

function startDisclosureSession(
  divaSessionId,
  attribute,
  attributesLabel,
) {
  const callbackUrl = appConfig.baseUrl + divaConfig.completeDisclosureSessionEndpoint;
  const sprequest = {
    callbackUrl,
    data: divaSessionId,
    validity: 60,
    timeout: 60,
    request: {
      content: [
        {
          label: attributesLabel,
          attributes: [attribute],
        },
      ],
    },
  };

  const jwtOptions = {
    algorithm: 'RS256',
    issuer: 'diva',
    subject: 'verification_request',
  };

  const signedVerificationRequestJwt = jwt.sign(
    { sprequest },
    divaConfig.apiKey,
    jwtOptions,
  );

  return request
    .post(divaConfig.irmaApiServerUrl + verificationEndpoint)
    .type('text/plain')
    .send(signedVerificationRequestJwt)
    .then(result => addApiServerUrl(result.body))
    .then(JSON.stringify)
    .catch((error) => {
      // TODO: make this a typed error
      const e = new Error(`Error starting IRMA session: ${error.message}`);
      return e;
    });
}

/**
 * Decode and verify JWT verify token from api server and check validity/signature
 * @function verifyIrmaJwt
 * @param {string} token JWT string
 * @returns {Promise<json>} decoded IRMA JWT token from api server
 */
function verifyIrmaApiServerJwt(token) {
  const key = divaConfig.irmaApiServerPublicKey;
  return BPromise.try(() => jwt.verify(token, key, jwtIrmaApiServerVerifyOptions));
}

/**
 * Check IRMA proof status
 * @function checkIrmaProofValidity
 * @param {json} jwtPayload IRMA JWT token from api server
 * @throws Error if status is not equal to 'VALID'
 * @returns {Promise<json>} decoded IRMA JWT token from api server
 */
function checkIrmaProofValidity(jwtPayload) {
  const proofStatus = jwtPayload.status;
  if (proofStatus !== 'VALID') {
    throw new Error(`Invalid IRMA proof status: ${proofStatus}`); // TODO: custom error class
  }
  return BPromise.resolve(jwtPayload);
}

/**
 * Verify an irma proof and return attributes and session
 * @function checkIrmaProofValidity
 * @param {string} IRMA proof jwt
 * @returns {Promise<json>} Map with Diva session token and IRMA attributes
 */
function verifyProof(proof) {
  return verifyIrmaApiServerJwt(proof)
    .then(decoded => checkIrmaProofValidity(decoded))
    .then(checkedToken => ({
      divaSessionId: checkedToken.jti,
      attributes: checkedToken.attributes,
    }));
}

function addProof(divaSessionId, attributes, proof) {
  divaState.set(divaSessionId, {
    attributes, // TODO merge current attributes with already existing attributes in session
    proof,
  });
}

// TODO Do we really want this to be stateful?
function completeDisclosureSession(proof) {
  return verifyProof(proof)
    .then((result) => {
      addProof(result.divaSessionId, result.attributes, proof);
    });
}

function getAttributes(divaSessionId) {
  if (divaState.get(divaSessionId) === undefined) {
    return {};
  }
  return divaState.get(divaSessionId).attributes;
}

function removeDivaSession(divaSessionId) {
  return divaState.delete(divaSessionId);
}

/**
* Module exports.
* @public
*/

module.exports.version = version;
module.exports.requireAttribute = requireAttribute;
module.exports.startDisclosureSession = startDisclosureSession;
module.exports.completeDisclosureSession = completeDisclosureSession;
module.exports.getAttributes = getAttributes;
module.exports.removeDivaSession = removeDivaSession;
