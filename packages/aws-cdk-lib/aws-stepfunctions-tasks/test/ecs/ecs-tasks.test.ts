import { describeDeprecated } from '@aws-cdk/cdk-build-tools';
import { Template } from '../../../assertions';
import * as autoscaling from '../../../aws-autoscaling';
import * as ec2 from '../../../aws-ec2';
import * as ecs from '../../../aws-ecs';
import * as sfn from '../../../aws-stepfunctions';
import { Stack } from '../../../core';
import * as tasks from '../../lib';

let stack: Stack;
let vpc: ec2.Vpc;
let cluster: ecs.Cluster;

beforeEach(() => {
  // GIVEN
  stack = new Stack();
  vpc = new ec2.Vpc(stack, 'Vpc');
  cluster = new ecs.Cluster(stack, 'Cluster', { vpc });
  cluster.addAsgCapacityProvider(new ecs.AsgCapacityProvider(stack, 'Capacity', {
    autoScalingGroup: new autoscaling.AutoScalingGroup(stack, 'ASG', {
      vpc,
      instanceType: new ec2.InstanceType('t3.medium'),
      machineImage: ec2.MachineImage.latestAmazonLinux(),
    }),
  }));
});

describeDeprecated('ecs-tasks', () => {
  test('Cannot create a Fargate task with a fargate-incompatible task definition', () => {
    const taskDefinition = new ecs.TaskDefinition(stack, 'TD', {
      memoryMiB: '512',
      cpu: '256',
      compatibility: ecs.Compatibility.EC2,
    });
    taskDefinition.addContainer('TheContainer', {
      image: ecs.ContainerImage.fromRegistry('foo/bar'),
      memoryLimitMiB: 256,
    });

    expect(() => new tasks.RunEcsFargateTask({ cluster, taskDefinition })).toThrow(/not configured for compatibility with Fargate/);
  });

  test('Cannot create a Fargate task without a default container', () => {
    const taskDefinition = new ecs.TaskDefinition(stack, 'TD', {
      memoryMiB: '512',
      cpu: '256',
      compatibility: ecs.Compatibility.FARGATE,
    });
    expect(() => new tasks.RunEcsFargateTask({ cluster, taskDefinition })).toThrow(/must have at least one essential container/);
  });

  test('Running a Fargate Task', () => {
    const taskDefinition = new ecs.TaskDefinition(stack, 'TD', {
      memoryMiB: '512',
      cpu: '256',
      compatibility: ecs.Compatibility.FARGATE,
    });
    const containerDefinition = taskDefinition.addContainer('TheContainer', {
      image: ecs.ContainerImage.fromRegistry('foo/bar'),
      memoryLimitMiB: 256,
    });

    // WHEN
    const runTask = new sfn.Task(stack, 'RunFargate', {
      task: new tasks.RunEcsFargateTask({
        integrationPattern: sfn.ServiceIntegrationPattern.SYNC,
        cluster,
        taskDefinition,
        containerOverrides: [
          {
            containerDefinition,
            environment: [
              { name: 'SOME_KEY', value: sfn.JsonPath.stringAt('$.SomeKey') },
            ],
          },
        ],
      }),
    });

    new sfn.StateMachine(stack, 'SM', {
      definitionBody: sfn.DefinitionBody.fromChainable(runTask),
    });

    // THEN
    expect(stack.resolve(runTask.toStateJson())).toEqual({
      End: true,
      Parameters: {
        Cluster: { 'Fn::GetAtt': ['ClusterEB0386A7', 'Arn'] },
        LaunchType: 'FARGATE',
        NetworkConfiguration: {
          AwsvpcConfiguration: {
            SecurityGroups: [{ 'Fn::GetAtt': ['RunFargateSecurityGroup709740F2', 'GroupId'] }],
            Subnets: [{ Ref: 'VpcPrivateSubnet1Subnet536B997A' }, { Ref: 'VpcPrivateSubnet2Subnet3788AAA1' }],
          },
        },
        TaskDefinition: { Ref: 'TD49C78F36' },
        Overrides: {
          ContainerOverrides: [
            {
              Environment: [
                {
                  'Name': 'SOME_KEY',
                  'Value.$': '$.SomeKey',
                },
              ],
              Name: 'TheContainer',
            },
          ],
        },
      },
      Resource: {
        'Fn::Join': [
          '',
          [
            'arn:',
            {
              Ref: 'AWS::Partition',
            },
            ':states:::ecs:runTask.sync',
          ],
        ],
      },
      Type: 'Task',
    });

    Template.fromStack(stack).hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: [
          {
            Action: 'ecs:RunTask',
            Effect: 'Allow',
            Resource: { Ref: 'TD49C78F36' },
          },
          {
            Action: ['ecs:StopTask', 'ecs:DescribeTasks'],
            Effect: 'Allow',
            Resource: '*',
          },
          {
            Action: 'iam:PassRole',
            Effect: 'Allow',
            Resource: [{ 'Fn::GetAtt': ['TDTaskRoleC497AFFC', 'Arn'] }],
          },
          {
            Action: ['events:PutTargets', 'events:PutRule', 'events:DescribeRule'],
            Effect: 'Allow',
            Resource: {
              'Fn::Join': [
                '',
                [
                  'arn:',
                  { Ref: 'AWS::Partition' },
                  ':events:',
                  { Ref: 'AWS::Region' },
                  ':',
                  { Ref: 'AWS::AccountId' },
                  ':rule/StepFunctionsGetEventsForECSTaskRule',
                ],
              ],
            },
          },
        ],
      },
    });
  });

  test('Running an EC2 Task with bridge network', () => {
    const taskDefinition = new ecs.TaskDefinition(stack, 'TD', {
      compatibility: ecs.Compatibility.EC2,
    });
    const containerDefinition = taskDefinition.addContainer('TheContainer', {
      image: ecs.ContainerImage.fromRegistry('foo/bar'),
      memoryLimitMiB: 256,
    });

    // WHEN
    const runTask = new sfn.Task(stack, 'Run', {
      task: new tasks.RunEcsEc2Task({
        integrationPattern: sfn.ServiceIntegrationPattern.SYNC,
        cluster,
        taskDefinition,
        containerOverrides: [
          {
            containerDefinition,
            environment: [
              { name: 'SOME_KEY', value: sfn.JsonPath.stringAt('$.SomeKey') },
            ],
          },
        ],
      }),
    });

    new sfn.StateMachine(stack, 'SM', {
      definitionBody: sfn.DefinitionBody.fromChainable(runTask),
    });

    // THEN
    expect(stack.resolve(runTask.toStateJson())).toEqual({
      End: true,
      Parameters: {
        Cluster: { 'Fn::GetAtt': ['ClusterEB0386A7', 'Arn'] },
        LaunchType: 'EC2',
        TaskDefinition: { Ref: 'TD49C78F36' },
        Overrides: {
          ContainerOverrides: [
            {
              Environment: [
                {
                  'Name': 'SOME_KEY',
                  'Value.$': '$.SomeKey',
                },
              ],
              Name: 'TheContainer',
            },
          ],
        },
      },
      Resource: {
        'Fn::Join': [
          '',
          [
            'arn:',
            {
              Ref: 'AWS::Partition',
            },
            ':states:::ecs:runTask.sync',
          ],
        ],
      },
      Type: 'Task',
    });

    Template.fromStack(stack).hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: [
          {
            Action: 'ecs:RunTask',
            Effect: 'Allow',
            Resource: { Ref: 'TD49C78F36' },
          },
          {
            Action: ['ecs:StopTask', 'ecs:DescribeTasks'],
            Effect: 'Allow',
            Resource: '*',
          },
          {
            Action: 'iam:PassRole',
            Effect: 'Allow',
            Resource: [{ 'Fn::GetAtt': ['TDTaskRoleC497AFFC', 'Arn'] }],
          },
          {
            Action: ['events:PutTargets', 'events:PutRule', 'events:DescribeRule'],
            Effect: 'Allow',
            Resource: {
              'Fn::Join': [
                '',
                [
                  'arn:',
                  { Ref: 'AWS::Partition' },
                  ':events:',
                  { Ref: 'AWS::Region' },
                  ':',
                  { Ref: 'AWS::AccountId' },
                  ':rule/StepFunctionsGetEventsForECSTaskRule',
                ],
              ],
            },
          },
        ],
      },
    });
  });

  test('Running an EC2 Task with placement strategies', () => {
    const taskDefinition = new ecs.TaskDefinition(stack, 'TD', {
      compatibility: ecs.Compatibility.EC2,
    });
    taskDefinition.addContainer('TheContainer', {
      image: ecs.ContainerImage.fromRegistry('foo/bar'),
      memoryLimitMiB: 256,
    });

    const ec2Task = new tasks.RunEcsEc2Task({
      integrationPattern: sfn.ServiceIntegrationPattern.SYNC,
      cluster,
      taskDefinition,
      placementStrategies: [ecs.PlacementStrategy.spreadAcrossInstances(), ecs.PlacementStrategy.packedByCpu(), ecs.PlacementStrategy.randomly()],
      placementConstraints: [ecs.PlacementConstraint.memberOf('blieptuut')],
    });

    // WHEN
    const runTask = new sfn.Task(stack, 'Run', { task: ec2Task });

    new sfn.StateMachine(stack, 'SM', {
      definitionBody: sfn.DefinitionBody.fromChainable(runTask),
    });

    // THEN
    expect(stack.resolve(runTask.toStateJson())).toEqual({
      End: true,
      Parameters: {
        Cluster: { 'Fn::GetAtt': ['ClusterEB0386A7', 'Arn'] },
        LaunchType: 'EC2',
        TaskDefinition: { Ref: 'TD49C78F36' },
        PlacementConstraints: [{ Type: 'memberOf', Expression: 'blieptuut' }],
        PlacementStrategy: [{ Field: 'instanceId', Type: 'spread' }, { Field: 'CPU', Type: 'binpack' }, { Type: 'random' }],
      },
      Resource: {
        'Fn::Join': [
          '',
          [
            'arn:',
            {
              Ref: 'AWS::Partition',
            },
            ':states:::ecs:runTask.sync',
          ],
        ],
      },
      Type: 'Task',
    });
  });

  test('Running an EC2 Task with overridden number values', () => {
    const taskDefinition = new ecs.TaskDefinition(stack, 'TD', {
      compatibility: ecs.Compatibility.EC2,
    });
    const containerDefinition = taskDefinition.addContainer('TheContainer', {
      image: ecs.ContainerImage.fromRegistry('foo/bar'),
      memoryLimitMiB: 256,
    });

    const ec2Task = new tasks.RunEcsEc2Task({
      integrationPattern: sfn.ServiceIntegrationPattern.SYNC,
      cluster,
      taskDefinition,
      containerOverrides: [
        {
          containerDefinition,
          command: sfn.JsonPath.listAt('$.TheCommand'),
          cpu: 5,
          memoryLimit: sfn.JsonPath.numberAt('$.MemoryLimit'),
        },
      ],
    });

    // WHEN
    const runTask = new sfn.Task(stack, 'Run', { task: ec2Task });

    // THEN
    expect(stack.resolve(runTask.toStateJson())).toEqual({
      End: true,
      Parameters: {
        Cluster: { 'Fn::GetAtt': ['ClusterEB0386A7', 'Arn'] },
        LaunchType: 'EC2',
        TaskDefinition: { Ref: 'TD49C78F36' },
        Overrides: {
          ContainerOverrides: [
            {
              'Command.$': '$.TheCommand',
              'Cpu': 5,
              'Memory.$': '$.MemoryLimit',
              'Name': 'TheContainer',
            },
          ],
        },
      },
      Resource: {
        'Fn::Join': [
          '',
          [
            'arn:',
            {
              Ref: 'AWS::Partition',
            },
            ':states:::ecs:runTask.sync',
          ],
        ],
      },
      Type: 'Task',
    });
  });

  test('Cannot create a task with WAIT_FOR_TASK_TOKEN if no TaskToken provided', () => {
    const taskDefinition = new ecs.TaskDefinition(stack, 'TaskDefinition', {
      compatibility: ecs.Compatibility.EC2,
    });

    const containerDefinition = taskDefinition.addContainer('ContainerDefinition', {
      image: ecs.ContainerImage.fromRegistry('foo/bar'),
    });

    expect(() =>
      new tasks.RunEcsEc2Task({
        cluster,
        containerOverrides: [
          {
            containerDefinition,
            environment: [
              {
                name: 'Foo',
                value: 'Bar',
              },
            ],
          },
        ],
        integrationPattern: sfn.ServiceIntegrationPattern.WAIT_FOR_TASK_TOKEN,
        taskDefinition,
      }),
    ).toThrow(/Task Token is required in at least one `containerOverrides.environment`/);
  });

  test('Running a task with WAIT_FOR_TASK_TOKEN and task token in environment', () => {
    const taskDefinition = new ecs.TaskDefinition(stack, 'TaskDefinition', {
      compatibility: ecs.Compatibility.EC2,
    });

    const primaryContainerDef = taskDefinition.addContainer('PrimaryContainerDef', {
      image: ecs.ContainerImage.fromRegistry('foo/primary'),
      essential: true,
    });

    const sidecarContainerDef = taskDefinition.addContainer('SideCarContainerDef', {
      image: ecs.ContainerImage.fromRegistry('foo/sidecar'),
      essential: false,
    });

    expect(() => new tasks.RunEcsEc2Task({
      cluster,
      containerOverrides: [
        {
          containerDefinition: primaryContainerDef,
          environment: [
            {
              name: 'Foo',
              value: 'Bar',
            },
          ],
        },
        {
          containerDefinition: sidecarContainerDef,
          environment: [
            {
              name: 'TaskToken.$',
              value: sfn.JsonPath.taskToken,
            },
          ],
        },
      ],
      integrationPattern: sfn.ServiceIntegrationPattern.WAIT_FOR_TASK_TOKEN,
      taskDefinition,
    })).not.toThrow();
  });
});
