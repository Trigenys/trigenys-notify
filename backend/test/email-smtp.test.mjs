import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {SMTPServer} from 'smtp-server';
import SMTPConnection from 'nodemailer/lib/smtp-connection';
import {sendSmtpEmail} from '../src/email-smtp.ts';

const settings={host:'mail.spacemail.com',port:465,user:'mailbox@example.com',password:'private fixture password'};
const message={from:'Commerce Factory <commercefactory@trigenys.com>',recipient:'merchant@example.com',
  messageId:'<fixture-email@trigenys.com>',date:'2026-10-29T12:00:00.000Z',subject:'Connexion sûre',
  text:'Fixture only. https://auth.example/token?code=123456',html:'<p>Fixture only.</p><a href="https://auth.example/token?code=123456">Me connecter</a>'};

test('real Nodemailer SMTP with verified TLS sends MIME text/HTML, keeps auth private and classifies refusals',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'notify-smtp-'));
  const keyFile=join(directory,'key.pem'),certFile=join(directory,'cert.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyFile,'-out',certFile,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{stdio:'ignore'});
  const cert=await readFile(certFile),key=await readFile(keyFile),messages=[];
  let reject=false;
  const server=new SMTPServer({secure:true,key,cert,logger:false,disabledCommands:['STARTTLS'],
    onAuth(auth,_session,callback){callback(null,auth.username===settings.user&&auth.password===settings.password?{user:'fixture'}:false);},
    onData(stream,session,callback){const chunks=[];stream.on('data',chunk=>chunks.push(chunk));stream.on('end',()=>{
      if(reject){const error=new Error('fixture refusal');error.responseCode=550;callback(error);return;}
      messages.push({envelope:session.envelope,body:Buffer.concat(chunks).toString()});callback(null,'fixture accepted');
    });}
  });
  server.on('error',()=>{});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const factory=options=>{
      assert.equal(options.secure,true);assert.equal(options.port,465);assert.equal(options.tls.rejectUnauthorized,true);
      assert.equal(options.tls.minVersion,'TLSv1.2');assert.equal(options.logger,false);assert.equal(options.debug,false);
      return new SMTPConnection({...options,host:'127.0.0.1',port:server.server.address().port,tls:{...options.tls,servername:'localhost',ca:cert}});
    };
    assert.deepEqual(await sendSmtpEmail(settings,message,factory),{accepted:true});
    assert.equal(messages.length,1);assert.equal(messages[0].envelope.mailFrom.address,'commercefactory@trigenys.com');
    assert.deepEqual(messages[0].envelope.rcptTo.map(r=>r.address),['merchant@example.com']);
    assert.match(messages[0].body,/multipart\/alternative/);assert.match(messages[0].body,/Content-Type: text\/plain/);assert.match(messages[0].body,/Content-Type: text\/html/);
    assert.match(messages[0].body,/Message-ID: <fixture-email@trigenys.com>/i);assert.equal(messages[0].body.includes(settings.password),false);
    reject=true;assert.deepEqual(await sendSmtpEmail(settings,message,factory),{accepted:false,safeToRetry:true});
    assert.deepEqual(await sendSmtpEmail({...settings,password:'wrong'},message,factory),{accepted:false,safeToRetry:true});
    assert.equal(messages.length,1);
  }finally{await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}
});

test('SMTP deadline closes the connection and classifies an unknown DATA acknowledgement without retry',async()=>{
  for(const phase of ['connect','data']){
    let closed=0;
    const factory=()=>({on(){},close(){closed++;},connect(callback){if(phase==='data')callback();},login(_auth,callback){callback();},send(){}});
    const result=await sendSmtpEmail(settings,message,factory);
    assert.deepEqual(result,{accepted:false,safeToRetry:phase==='connect'});assert.equal(closed,1);
  }
});
