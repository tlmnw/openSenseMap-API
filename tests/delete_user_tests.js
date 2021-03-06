'use strict';

/* global describe it */

const chakram = require('chakram'),
  expect = chakram.expect;

const BASE_URL = process.env.OSEM_TEST_BASE_URL,
  valid_user = { email: 'luftdaten@email', password: '87654321' };

describe('openSenseMap API Delete User tests', function () {
  let jwt, num_boxes_before, num_measurements_before;

  it('should deny to delete user without jwt', function () {
    return chakram.delete(`${BASE_URL}/users/me`)
      .then(function (response) {
        expect(response).to.have.status(401);

        return chakram.get(`${BASE_URL}/stats`);
      })
      .then(function (response) {
        [ num_boxes_before, num_measurements_before ] = response.body;
      });
  });

  it('should deny to delete user without password parameter', function () {
    return chakram.post(`${BASE_URL}/users/sign-in`, valid_user)
      .then(function (response) {
        expect(response).to.have.status(200);
        expect(response.body.token).to.be.not.empty;
        jwt = response.body.token;

        return chakram.delete(`${BASE_URL}/users/me`, {}, { headers: { 'Authorization': `Bearer ${jwt}` } });
      })
      .then(function (response) {
        expect(response).to.have.status(400);

        return chakram.wait();
      });
  });

  it('should deny to delete user with empty password parameter', function () {
    return chakram.delete(`${BASE_URL}/users/me`, { password: '' }, { headers: { 'Authorization': `Bearer ${jwt}` } })
      .then(function (response) {
        expect(response).to.have.status(422);

        return chakram.wait();
      });
  });

  it('should deny to delete user with wrong password parameter', function () {
    return chakram.delete(`${BASE_URL}/users/me`, { password: `${valid_user.password}hallo` }, { headers: { 'Authorization': `Bearer ${jwt}` } })
      .then(function (response) {
        expect(response).to.have.status(400);

        return chakram.wait();
      });
  });

  it('should allow to delete user with correct password parameter', function () {
    return chakram.delete(`${BASE_URL}/users/me`, { password: valid_user.password }, { headers: { 'Authorization': `Bearer ${jwt}` } })
      .then(function (response) {
        expect(response).to.have.status(200);

        return chakram.post(`${BASE_URL}/users/sign-in`, valid_user);
      })
      .then(function (response) {
        expect(response).to.have.status(401);

        return chakram.get(`${BASE_URL}/stats`, { headers: { 'x-apicache-bypass': true } });
      })
      .then(function (response) {
        expect(response).status(200);
        const [ boxes, measurements ] = response.body;

        expect(boxes).to.be.below(num_boxes_before);
        expect(measurements).to.be.below(num_measurements_before);

        return chakram.wait();
      });
  });

});
